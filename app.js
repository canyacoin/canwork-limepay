'use strict'

/**
 * @summary Initialize firebase
 */
require('./firebase-config');
const FirestoreService = require('./firestore-service');
const firestore = FirestoreService.firestore;

const express = require('express'),
    axios = require('axios'),
    ethers = require('ethers'),
    cors = require('cors'),
    LimePaySDK = require('limepay'),
    Monitor = require('./monitor'),
    firebaseMiddleware = require('express-firebase-middleware')

let LimePay
let MonitorInstance;
    
/**
 * @summary Config
 */
const CONFIG = require('./config')

/**
 * @summary Global variables
 */
const PAYMENT_TYPES = require('./constants.json').PAYMENT_TYPES;
const abi_canwork = require('./abi/canwork.json')
const abi_canyacoin = require('./abi/canyacoin.json')
const signerWalletConfig = { privateKey: CONFIG.SIGNER_WALLET_KEY };

/**
 * @summary Express configuration and setup
 * @description Sets express.js server with middleware for cors, 
 *  firebase JWT authentication and error handling
 */
const app = express()
app.use(express.json())
app.use(cors({
    origin: ['http://localhost:4200', 'https://localhost:4200', 'https://staging-can-work.firebaseapp.com', 'https://canwork.io', 'https://www.canwork.io', 'https://staging.canya.com', 'https://www.staging.canya.com']
}))
app.use('/auth/', firebaseMiddleware.auth)
/**
 * @name / - Firestore connection checker
 * @summary Checks connection to firestore by reading collections and returning length 
 * @returns 200 on connection, 500 on error
 */
app.get('/', async (req, res) => {
    try {
        const col = await firestore().listCollections()
        res.status(200).send(`connected:${col.length > 0}`).end()
    } catch (e) {
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
    } catch (e) {
        res.json({
            message: `Not logged in`
        })
    }
})


/* ---------- SHOPPER MANAGEMENT --------------*/

/**
 * @name CreateShopper
 * @summary Pulls user information from firestore and creates 
 *  a Limepay shopper object. Shopper ID is then saved to firestore
 * @requires Firebase middleware authentication 
 * @returns Shopper object from limepay, or an error
 */
app.post('/auth/createShopper', async (req, res, next) => {
    try {
        const user = await FirestoreService.getUser(res.locals.user.uid)
        var fullName = user.name.split(' '),
            shopperFirstName = fullName[0],
            shopperLastName = fullName[fullName.length - 1]
        var shopperData = {
            firstName: shopperFirstName,
            lastName: shopperLastName,
            email: user.email,
            useLimePayWallet: true
        }
        console.log('creating shopper...')
        LimePay.shoppers.create(shopperData).then(async (shopper) => { 
            if(shopper) {
                await FirestoreService.setShopper(res.locals.user.uid, { shopperId: shopper._id })  
                res.json({...shopper, shopperId: shopper._id})
            } else {
                next('error. shopper null')
            }
        }).catch(error => {
            console.log(error)
            next(error)
        })
    } catch (error) {
        next(error)
    }
})

/**
 * @name GetShopper
 * @summary Method to retrieve shopper data from Limepay
 * @requires Firebase middleware authentication 
 * @returns Shopper object, or null if it doesn't exist
 */
app.get('/auth/getShopper', async (req, res, next) => {
    try {
        const shopper = await getShopper(res.locals.user.uid)
        res.json(shopper)
    } catch (error) {
        next(error)
    }
})


/* --------- WALLET MANAGEMENT ------------ */

/**
 * @name GetWalletToken
 * @summary Method to retrieve wallet token for a specific user. This 
 *  token is used to retrieve/create the wallet object on the client (LimePay-Web)
 * @requires Firebase middleware authentication
 * @returns Wallet token for the shopper
 */
app.get('/auth/getWalletToken', async (req, res, next) => {
    try {
        const shopper = await getShopper(res.locals.user.uid)
        console.log('getWalletToken: ', shopper)
        const token = await LimePay.shoppers.getWalletToken(shopper.shopperId) // returns new Promise<>
        console.log('getWalletToken: ', token)
        res.json(token)
    } catch (error) {
        next(error)
    }
})


/* ---------- PAYMENT --------------*/

/**
 * @name InitFiatPayment
 * @summary Create and sign the fiat payment to create a job
 * @description Initialises the fiat payment required to enter the canwork escrow. 
 *  Retrieves all the objects needed to get the job creation data ( sent to limepay ).
 *  Sets IMPORTANT properties on the job object (budgetCan, client/provider eth address) 
 * @requires Firebase middleware authentication
 *  body: jobId / providerEthAddress
 * @returns Payment token, Payment ID and Transactions that will need to be signed by the shopper
 */
app.post('/auth/initFiatPayment', async (req, res, next) => {
    try {
        const jobId = req.body.jobId
        const providerEthAddress = req.body.providerEthAddress
        const userId = res.locals.user.uid
        if (!jobId || !providerEthAddress || !userId) next('Missing arguments')
        else {
            const job = await FirestoreService.getJob(jobId)
            const shopper = await getShopper(userId)
            const jobValueCan = await getExchangeRate('DAI', job.budget)
            const jobUpdated = await FirestoreService.setJob({...job, budgetCan: jobValueCan, clientEthAddress: shopper.walletAddress, providerEthAddress: providerEthAddress})
            console.log('Job updated: ', jobUpdated)
            const fiatPaymentData = await getJobCreationData(shopper.shopperId, job.information.title, job.budget, jobValueCan,
                job.hexId, shopper.walletAddress, providerEthAddress)
            console.log('Job creation data: ', fiatPaymentData)
            const createdPayment = await LimePay.fiatPayment.create(fiatPaymentData, signerWalletConfig)
            console.log('Signed payment: ', createdPayment)
            const clientTx = await getJobCreationData(shopper.shopperId, job.information.title, job.budget, job.budgetCan, 
                job.hexId, shopper.walletAddress, providerEthAddress, true)
            res.json({ transactions: clientTx.genericTransactions, paymentToken: createdPayment.limeToken, paymentId: createdPayment._id })
        }        
    } catch (error) {
        next(error)
    }
})

/**
 * @name InitRelayedPayment
 * @summary Create and sign the relayed payment to mark a job as completed
 * @description Initialises the relayed payment required to mark the job as completed. 
 * @requires Firebase middleware authentication
 *  body: jobId
 * @returns Payment token, Payment ID and Transactions that will need to be signed by the shopper
 */
app.post('/auth/initRelayedPayment', async (req, res, next) => {
    try {
        const jobId = req.body.jobId
        const userId = res.locals.user.uid
        if (!jobId || !userId) next('Missing arguments')
        else {
            const job = await FirestoreService.getJob(jobId)
            const shopper = await getShopper(userId)
            const relayedPaymentData = await getJobCompletionData(shopper.shopperId, job.hexId)
            console.log('Job Completion data: ', relayedPaymentData)
            
            const createdPayment = await LimePay.relayedPayment.create(relayedPaymentData, signerWalletConfig)
            console.log('Signed payment: ', createdPayment)
            
            const clientTx = await getJobCompletionData(shopper.shopperId, job.hexId, true);
            res.json({ transactions: clientTx.genericTransactions, paymentToken: createdPayment.limeToken, paymentId: createdPayment._id })
        }
    } catch (error) {
        console.log('ERR: ', JSON.stringify(error), error)
        next(error)
    }
})

/* --------- Monitoring ------------ */

/**
 * @name Monitor
 * @summary Create and sign the relayed payment to mark a job as completed
 * @description Initialises the relayed payment required to mark the job as completed.
 * @requires Firebase middleware authentication
 *  body: jobId
 * @returns Payment token, Payment ID and Transactions that will need to be signed by the shopper
 */

app.get('/auth/monitor', async (req, res, next) => {
    try {
        const paymentId = req.param('paymentId');
        const jobId = req.param('jobId');

        if (!paymentId || !jobId) next('Missing arguments');
        else {
            // Check whether the Job is paid with LimePay
            const job = await FirestoreService.getJob(jobId);
            if (!job.fiatPayment) {
                console.log(`Cannot monitor payment with id ${paymentId} for job with id ${jobId} that is not using LimePay`);
                res.json({ message: 'Cannot monitor the payment, because the Job was not paid with LimePay' }).end();
            } else {
                
                // Get the Payment and check whether we are already monitoring it
                const paymentInDb = await FirestoreService.getPayment(paymentId);
                if (paymentInDb) {
                    console.log(`Payment with id ${paymentId} was already send for monitoring`);
                } else {
                    // Add the new payment in firestore
                    const payment = { id: paymentId, jobId: jobId, type: getPaymentType(job.state)};
                    await FirestoreService.setPayment(payment);
    
                    // Update the state of the Job
                    await updateJobState(job, payment.type);
    
                    // Trigger the monitoring of the LimePay payment
                    MonitorInstance.monitor(paymentId);
                }

                res.json({});
            }
        }
    } catch (error) {
        console.log('ERR: ', JSON.stringify(error), error)
        next(error)
    }
});

/* --------- GETTERS ------------ */

/**
 * @name Enter-Escrow-Tx
 * @summary Gets the transactions required for the enter escrow 
 * @requires Firebase middleware authentication
 * @param jobId
 * @returns Transactions that will need to be signed by the shopper
 */
app.get('/auth/enter-escrow-tx', async (req, res) => {
    try {
        const jobId = req.param('jobId')
        const shopper = await getShopper(res.locals.user.uid)
        const job = await getJob(jobId)
        const fiatPaymentData = await getJobCreationData(shopper.shopperId, job.information.title, job.budget, job.budgetCan,
            job.hexId, shopper.walletAddress, job.providerEthAddress, true)
        res.json(fiatPaymentData.genericTransactions)
    } catch (e) {
        res.json({
            message: `Not logged in`
        })
    }
})

/**
 * @name Get-Payment-Status
 * @summary Gets the status of a limepay payment 
 * @requires Firebase middleware authentication
 * @param paymentId
 * @returns the status of the payment
 */
app.get('/auth/get-payment-status', async (req, res) => {
    try {
        const paymentId = req.param('paymentId');
        const payment = await LimePay.payments.get(paymentId);
        
        const transactions = populateGenericTXData(payment.genericTransactions);
        res.json({ status: payment.status, transactions });
    } catch (e) {
        console.log('ERR: ', JSON.stringify(error), error)
        next(error)
    }
})

app.use((err, req, res, next) => {
    console.log('ERR: ', err);
    res.status(500).send(err);
})


/* ---------- EXPRESS INIT --------------*/

/**
 * @summary Starts the express application
 * @description Sets up express.js and app constants - Limepay && firestore
 */
const PORT = process.env.PORT || 8080
app.listen(PORT, async () => {
    LimePay = await LimePaySDK.connect({
        environment: LimePaySDK.Environment[CONFIG.ENV], // LimePaySDK.Environment.Production,
        apiKey: CONFIG.API_KEY,
        secret: CONFIG.API_SECRET
    })
    
    MonitorInstance = new Monitor(LimePay);
    console.log(`Sample app listening at http://localhost:` + PORT)
})

/* ----------------- UTILS / HELPERS -----------------*/

/**
 * @function @name getPaymentType
 * @summary Gets the type of the LimePay payment whether it is for Job Creation or Job Completion
 * @param state the state of the Job 
 * @returns returns `JOB_CREATION` or `JOB_COMPLETION` whether the payment is for creating of completing a job
 */
const getPaymentType = function (state) {
    if (state == 'Pending completion') {
        return PAYMENT_TYPES.JOB_COMPLETION;
    } else if (state == 'Awaiting Escrow') {
        return PAYMENT_TYPES.JOB_CREATION;
    }

    throw 'Invalid job state';
}

/**
 * @function @name getExchangeRate
 * @summary Hits our GETH connected microservice to retrieve the current price rate for DAI -> CAN
 * @param fromCur ('DAI' || 'CAN')
 * @param amount (amount WITHOUT decimals)
 * @returns The converted value
 */
const getExchangeRate = async (fromCur, amount) => {
    try {
        var value = await axios.get(`${CONFIG.ORACLE_URL}?currency=${fromCur}&amount=${amount}`)
        console.log(`Job budget can: `, value.data.result)
        return Promise.resolve(value.data.result)
    } catch (e) {
        return Promise.reject(e)
    }
}


// Get the shopper object from firestore
/**
 * @function @name getShopper
 * @summary Gets the Limepay shopper object using the specified userId
 * @param userId -- string
 * @returns ShopperID ++ limepay shopper object
 */
const getShopper = (userId) => {
    return new Promise(async (resolve, reject) => {
        try {
            const db = firestore()
            var shopperRef = db.collection('shoppers').doc(userId)
            const doc = await shopperRef.get();
            if (!doc.exists) {
                resolve(null)
            } else {
                const shopperId = doc.data().shopperId
                const shopper = await LimePay.shoppers.get(shopperId)
                resolve({
                    ...shopper,
                    shopperId
                })
            }
        } catch (e) {
            reject(e)
        }
    })
}

/**
 * @function @name getJobCreationData
 * @summary Get the fiat payment object required for creating the job
 * @param {String} shopperId -- limepay shopper id
 * @param {String} jobTitle -- Title of the job
 * @param {number} jobPriceUsd -- Price of the job in USD
 * @param {number} jobPriceCan -- Price of the job in CAN
 * @param {String} jobIdHex -- hexId of the job
 * @param {String} shopperAddress -- ethAddress of the shopper/client (limepay)
 * @param {String} providerAddress -- ethAddress of the provider of the job
 * @param {boolean} forClient -- Return transactions that can be signed by the shopper/client?
 * @returns {object} Limepay fiat payment object, including signable transactions and everything necessary to process full job
 */
const getJobCreationData = async (shopperId, jobTitle, jobPriceUsd, jobPriceCan, jobIdHex, shopperAddress, providerAddress, forClient = false) => {
    console.log('Params:', shopperId, jobTitle, jobPriceUsd, jobPriceCan, jobIdHex, shopperAddress, providerAddress)
    jobPriceCan = jobPriceCan * (10 ** 6)
    jobIdHex = rightPad(jobIdHex, 64)
    const gasPriceWei = await getGasPrice()
    let gasPriceBN = ethers.utils.bigNumberify(gasPriceWei)

    let approveGasLimit = 55000
    let approveGasLimitBN = ethers.utils.bigNumberify(approveGasLimit)
    let approveWeiAmount = gasPriceBN.mul(approveGasLimitBN)

    let jobGasLimit = 390000
    let jobGasLimitBN = ethers.utils.bigNumberify(jobGasLimit)
    let jobWeiAmount = gasPriceBN.mul(jobGasLimitBN)

    let totalWeiAmount = jobWeiAmount.add(approveWeiAmount).toString()

    return {
        shopper: shopperId,
        currency: "USD",
        items: [{
            description: jobTitle,
            lineAmount: jobPriceUsd,
            quantity: 1
        }],
        fundTxData: {
            tokenAmount: jobPriceCan,
            weiAmount: totalWeiAmount
        },
        genericTransactions: [{
                gasPrice: gasPriceWei,
                gasLimit: approveGasLimit,
                to: CONFIG.CANYACOIN_ADDRESS,
                abi: abi_canyacoin,
                functionName: "approve",
                functionParams: forClient ? [CONFIG.CANWORK_ADDRESS, jobPriceCan] : [{
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
                functionName: "createJob",
                functionParams: forClient ? [jobIdHex, shopperAddress, providerAddress, jobPriceCan] : [{
                        type: 'bytes32',
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

/**
 * @function @name getJobCompletionData
 * @summary Get the relayed payment object required for marking the job as completed job
 * @param {String} shopperId -- limepay shopper id
 * @param {String} jobIdHex -- hexId of the job
 * @param {boolean} forClient -- Return transactions that can be signed by the shopper/client?
 * @returns {object} Limepay relayed payment object, including signable transactions and everything necessary to process full job
 */
const getJobCompletionData = async (shopperId, jobIdHex, forClient = false) => {
    console.log('Params:', shopperId, jobIdHex)
    jobIdHex = rightPad(jobIdHex, 64)
    const gasPriceWei = await getGasPrice()
    let gasPriceBN = ethers.utils.bigNumberify(gasPriceWei)

    let jobCompletionLimit = 320000
    let jobCompletionGasLimitBN = ethers.utils.bigNumberify(jobCompletionLimit)
    let jobCompletionWeiAmount = gasPriceBN.mul(jobCompletionGasLimitBN).toString()

    return {
        shopper: shopperId,
        fundTxData: {
            weiAmount: jobCompletionWeiAmount
        },
        genericTransactions: [{
            gasPrice: gasPriceWei,
            gasLimit: jobCompletionLimit,
            to: CONFIG.CANWORK_ADDRESS,
            abi: abi_canwork,
            functionName: "completeJob",
            functionParams: forClient ? [jobIdHex] : [{
                type: 'bytes32',
                value: jobIdHex
            }]
        }]
    }
}

/**
 * Should be called to pad string to expected length
 *
 * @method rightPad
 * @param {String} string to be padded
 * @param {Number} chars that result string should have
 * @param {String} sign, by default 0
 * @returns {String} right aligned string
 */
var rightPad = function (string, chars, sign) {
    var hasPrefix = /^0x/i.test(string) || typeof string === 'number';
    string = string.toString(16).replace(/^0x/i, '');

    var padding = (chars - string.length + 1 >= 0) ? chars - string.length + 1 : 0;

    return (hasPrefix ? '0x' : '') + string + (new Array(padding).join(sign ? sign : "0"));
};



/**
 * @function @name getGasPrice
 * @returns {String} Gas price in gwei from specified gas station
 */
const getGasPrice = async () => {
    var price = await axios.get(CONFIG.GAS_STATION_URL)
    var parsedPrice = ethers.utils.parseUnits((price.data.fast / 10).toString(10), 'gwei')
    return parsedPrice.toString()
}

/**
 * @function @name populateGenericTXData
 * @returns {Object}
 */
const populateGenericTXData = (genericTransactions) => {
    let transactions = [];
    genericTransactions.forEach((tx, index) => {
        transactions[index] = { status: tx.status, transactionHash: tx.transactionHash };
    })
    return transactions;
}

/**
 * @function @name updateJobState
 * @param {Object} job 
 * @param {String} paymentType
 * @description updates the state of the job to indicate that a payment is in process. Depending on the payment types, two types of states are used.
 * if the type is JOB_CREATION the state is Processing Escrow. If the type is JOB_COMPLETION the state is Finishing Job 
 */
const updateJobState = async (job, paymentType) => {
    if (paymentType == PAYMENT_TYPES.JOB_COMPLETION) {
        job.state = 'Finishing Job';
    } else if (paymentType == PAYMENT_TYPES.JOB_CREATION) {
        job.state = 'Processing Escrow';
    } else {
        throw 'Invalid payment type';
    }

    await FirestoreService.setJob(job);
}