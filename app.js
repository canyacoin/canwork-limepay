'use strict'
const express = require('express'),
    axios = require('axios'),
    ethers = require('ethers'),
    cors = require('cors'),
    LimePaySDK = require('limepay'),
    admin = require('firebase-admin'),
    firebaseMiddleware = require('express-firebase-middleware')
let LimePay

/* --------- CONFIG------------ */
const signerWallet = require('./signer-wallet')
const sampleShopperWallet = require('./sample-shopper-wallet') // PASSWORD = sogfiuhsidoufhsdafofd
const CONFIG = require('./config')
const serviceAccount = require('./firebasekey.json')
const abi_canwork = require('./abi/canwork.json')
const abi_canyacoin = require('./abi/canyacoin.json')

const signerWalletConfig = {
    encryptedWallet: {
        jsonWallet: JSON.stringify(signerWallet),
        password: CONFIG.SIGNER_WALLET_PASSPHRASE
    }
}

/* --------- EXPRESS SETUP ------------ */
const app = express()
app.use(express.json())
app.use(cors({
    origin: ['http://localhost:4200', `https://staging-can-work.firebaseapp.com`, 'https://canwork.io']
}))
app.use('/auth/', firebaseMiddleware.auth)
app.use((err, request, response, next) => {
    console.log(err)
    response.status(500).send(err)
})

// Basic firestore connection check
app.get('/', async (req, res) => {
    try {
        const col = await firestore().listCollections()
        res.status(200).send(`connected:${col.length > 0}`).end()
    } catch (e){
        console.log(e)
        res.status(500).send(JSON.stringify(e)).end()
    }
})

// Basic middleware check
app.get('/auth/status', async (req, res) => {
    try {
        res.json({
            message: `You're logged in as ${res.locals.user.email} with Firebase UID: ${res.locals.user.uid}`
        })
    } catch (e){
        res.json({
            message: `Not logged in`
        })
    }
})

/* --------- WALLET / SHOPPER MANAGEMENT ------------ */
// Stub method for creating a shoppers wallet
// Body { password: '<password to generate wallet>' }
app.post('/auth/createWallet', async (request, response, next) => {
    try {
        console.log(request.body)
        //TODO - use limepay SDK to create and store the wallet object, then return it
        response.json({ wallet: sampleShopperWallet })
    } catch (error) {
        next(error)
    }
})

// Stub method for getting shoppers wallet
// Params: shopperId
app.get('/auth/getWallet', async (request, response, next) => {
    try {
        console.log(request.query.shopperId)
        //TODO - get wallet from SDK
        response.json({ wallet: sampleShopperWallet })
    } catch (error) {
        next(error)
    }

})

//TODO - getShopper (https://github.com/LimePay/docs/blob/latest/3.%20JS-SDK-documentation.md#21-getting-shopper)

//TODO - createShopper (https://github.com/LimePay/docs/blob/latest/3.%20JS-SDK-documentation.md#23-creating-shopper)


/* ---------- PAYMENT --------------*/
// Create and sign the fiat payment to create a job
// body: jobId / providerEthAddress
app.post('/auth/fiatPayment', async (req, res, next) => {
    try {
        const jobId = req.body.jobId
        const providerEthAddress = req.body.providerEthAddress
        const userId = res.locals.user.uid
        if(!jobId || !providerEthAddress || !userId) next('Missing arguments')
        else {
            const job = await getJob(jobId)
            const shopper = await getShopper(userId)
            const jobValueCan = await getExchangeRate('DAI', job.budget)
            const jobUpdated = await setJob({...job, budgetCan: jobValueCan, clientEthAddress: shopper.address, providerEthAddress: providerEthAddress})
            console.log('Job updated: ', jobUpdated)
            const fiatPaymentData = await getJobCreationData(shopper.id, job.information.title, job.budget, jobValueCan, 
                job.hexId, shopper.address, providerEthAddress)
            console.log('Job creation data: ', fiatPaymentData)
            const createdPayment = await LimePay.fiatPayment.create(fiatPaymentData, signerWalletConfig)
            console.log('Signed payment: ', createdPayment)
            response.json({ token: createdPayment.limeToken })
        }        
    } catch (error) {
        next(error)
    }
})




/* --------- GETTERS ------------ */
// Gets the transactions required for the enter escrow 
// @param jobId = job ID
app.get('/auth/enter-escrow-tx', async (req, res) => {
    try {
        const jobId = req.param('jobId')
        const shopper = await getShopper(res.locals.user.uid)
        const job = await getJob(jobId)
        const fiatPaymentData = await getJobCreationData(shopper.id, job.information.title, job.budget, job.budgetCan, 
            job.hexId, shopper.address, job.providerEthAddress)
        res.json(fiatPaymentData.genericTransactions)
    } catch (e){
        res.json({
            message: `Not logged in`
        })
    }
})



/* ---------- EXPRESS INIT --------------*/
const PORT = process.env.PORT || 8080
app.listen(PORT, async () => {
    LimePay = await LimePaySDK.connect({
        environment: LimePaySDK.Environment[CONFIG.ENV], // LimePaySDK.Environment.Production,
        apiKey: CONFIG.API_KEY,
        secret: CONFIG.API_SECRET
    })
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    })
    console.log(`Sample app listening at http://localhost:` + PORT)
})





/* ----------------- UTILS / HELPERS -----------------*/

// Get firestore
const firestore = () => admin.firestore()

// Calculates the conversion between DAI & CAN
const getExchangeRate = async (fromCur, amount) => {
    try {
        var value = await axios.get(`${CONFIG.ORACLE_URL}?currency=${fromCur}&amount=${amount}`)
        console.log(`Job budget can: `, value.data.result)
        return Promise.resolve(value.data.result)
    } catch (e) {
        return Promise.reject(e)
    }
}

// Get the job object from firestore
const getJob = (jobId) => {
    return new Promise((resolve, reject) => {
        try {
            const db = firestore()
            var jobRef = db.collection('jobs').doc(jobId)
            jobRef.get().then(doc => {
                if (!doc.exists) {
                    reject('No such document!')
                } else {
                    resolve(doc.data())
                }
            })
        } catch (e) {
            reject(e)
        }
    }) 
}

// Set the job object in firestore
const setJob = (job) => {
    return new Promise((resolve, reject) => {
        try {
            const db = firestore()
            db.collection('jobs').doc(job.id).set(job, {merge: true}).then(res => {
                resolve(res)
            }).catch(e => {
                reject(e)
            })
        } catch (e) {
            reject(e)
        }
    }) 
}

// Get the shopper object from firestore
const getShopper = (userId) => {
    return new Promise((resolve, reject) => {
        try {
            const db = firestore()
            var shopperRef = db.collection('shoppers').doc(userId)
            shopperRef.get().then(doc => {
                if (!doc.exists) {
                    reject('No such document!')
                } else {
                    resolve(doc.data())
                }
            })
        } catch (e) {
            reject(e)
        }
    }) 
}

// Set the job object in firestore
const setShopper = (userId, shopper) => {
    return new Promise((resolve, reject) => {
        try {
            const db = firestore()
            db.collection('shoppers').doc(userId).set(shopper, {merge: true}).then(res => {
                resolve(res)
            }).catch(e => {
                reject(e)
            })
        } catch (e) {
            reject(e)
        }
    }) 
}

// Get the fiat payment object required for creating the job
const getJobCreationData = async (shopperId, jobTitle, jobPriceUsd, jobPriceCan, jobIdHex, shopperAddress, providerAddress) => {
    console.log('Job creation params: ', {shopperId, jobTitle, jobPriceUsd, jobPriceCan, jobIdHex, shopperAddress, providerAddress})
    jobPriceCan  = jobPriceCan * (10 ** 6)

    const gasPriceWei = await getGasPrice()
    let gasPriceBN = ethers.utils.bigNumberify(gasPriceWei)

    let approveGasLimit = 55000
    let approveGasLimitBN = ethers.utils.bigNumberify(approveGasLimit)
    let approveWeiAmount = gasPriceBN.mul(approveGasLimitBN)

    let jobGasLimit = 390000
    let jobGasLimitBN = ethers.utils.bigNumberify(jobGasLimit)
    let jobWeiAmount = gasPriceBN.mul(jobGasLimitBN)

    let totalWeiAmount = jobWeiAmount.add(approveWeiAmount)

    return {
        shopper: shopperId, 
        currency: "USD",
        items: [
            {
                description: jobTitle,
                lineAmount: jobPriceUsd,
                quantity: 1
            }
        ],
        fundTxData: {
            tokenAmount: jobPriceCan,
            weiAmount: totalWeiAmount
        },
        genericTransactions: [
            {
                gasPrice: gasPriceWei,
                gasLimit: approveGasLimit,
                to: CONFIG.CANYACOIN_ADDRESS,
                abi: abi_canyacoin,
                value: 0,
                functionName: "approve",
                functionParams: [
                    {
                        type: 'address',
                        value: CONFIG.CANWORK_ADDRESS,
                    },
                    {
                        type: 'uint',
                        value: jobPriceCan,
                    }
                ]
            },
            {
                gasPrice: gasPriceWei,
                gasLimit: jobGasLimit,
                to: CONFIG.CANWORK_ADDRESS,
                abi: abi_canwork,
                value: 0,
                functionName: "createJob",
                functionParams: [
                    {
                        type: 'bytes',
                        value: jobIdHex
                    },
                    {
                        type: 'address',
                        value: shopperAddress,
                    },
                    {
                        type: 'address',
                        value: providerAddress,
                    },
                    {
                        type: 'uint',
                        value: jobPriceCan
                    }
                ]
            }
        ]
    }
}



const getGasPrice = async () => {
    var price = await axios.get(CONFIG.GAS_STATION_URL)
    var parsedPrice = ethers.utils.parseUnits((price.data.fast / 10).toString(10), 'gwei')
    return parsedPrice.toString()
}