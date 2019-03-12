'use strict';
const express = require('express'),
    axios = require('axios'),
    ethers = require('ethers'),
    cors = require('cors'),
    LimePaySDK = require('limepay'),
    admin = require('firebase-admin'),
    firebaseMiddleware = require('express-firebase-middleware');
let LimePay;

/* --------- CONFIG------------ */
const signerWallet = require('./signer-wallet');
const sampleShopperWallet = require('./sample-shopper-wallet'); // PASSWORD = sogfiuhsidoufhsdafofd
const CONFIG = require('./config');
const serviceAccount = require('./firebasekey.json');

const signerWalletConfig = {
    encryptedWallet: {
        jsonWallet: JSON.stringify(signerWallet),
        password: CONFIG.SIGNER_WALLET_PASSPHRASE
    }
};

/* --------- EXPRESS SETUP ------------ */
const app = express();
app.use(express.json())
app.use(cors({
    origin: ['http://localhost:4200', 'https://localhost:4200', `https://staging-can-work.firebaseapp.com`, 'https://canwork.io']
}))
app.use('/auth/', firebaseMiddleware.auth)
app.use((err, request, response, next) => {
    console.log(err);
    response.status(500).send(err);
});

// Basic firestore connection check
app.get('/', async (req, res) => {
    try {
        const col = await firestore().listCollections();
        res.status(200).send(`connected:${col.length > 0}`).end();
    } catch (e) {
        console.log(e)
        res.status(500).send(JSON.stringify(e)).end();
    }
});

// Basic middleware check
app.get('/auth/status', async (req, res) => {
    try {
        res.json({
            message: `You're logged in as ${res.locals.user.email} with Firebase UID: ${res.locals.user.uid}`
        });
    } catch (e) {
        res.json({
            message: `Not logged in`
        });
    }
});

/* --------- WALLET / SHOPPER MANAGEMENT ------------ */
// Stub method for creating a shoppers wallet
// Body { password: '<password to generate wallet>' }
app.post('/auth/createWallet', async (request, response, next) => {
    try {
        console.log(request.body)
        //TODO - use limepay SDK to create and store the wallet object, then return it
        response.json({
            wallet: sampleShopperWallet
        });
    } catch (error) {
        next(error);
    }
});

// Stub method for getting shoppers wallet
// Params: shopperId
app.get('/auth/getWallet', async (request, response, next) => {
    try {
        console.log(request.query.shopperId)
        //TODO - get wallet from SDK
        response.json({
            wallet: sampleShopperWallet
        });
    } catch (error) {
        next(error);
    }

});

// Method to check whether or not a user is already in the shopper collection
app.post('/isShopper', async (request, response, next) => {
    try {
        console.log(request.query.shopperId)
        const shopper = await getShopper(request.body.userId);
        if (shopper !== null) {
            response.json({
                isShopper: true
            });
        } else {
            response.json({
                isShopper: false
            });
        }
    } catch (error) {
        next(error)
    }
});


//TODO - getShopper (https://github.com/LimePay/docs/blob/latest/3.%20JS-SDK-documentation.md#21-getting-shopper)


//TODO - createShopper (https://github.com/LimePay/docs/blob/latest/3.%20JS-SDK-documentation.md#23-creating-shopper)

/* ---------- SHOPPER --------------*/
// Create the shopper. params : 
app.post('/createShopper', async (request, response, next) => {
    try {
        console.log(request.body)
        //TODO - get the required params from request.body, or hook up to firebase and pass to getFiatData
        const user = await getUser(request.body.userId);
        var fullName = user.name.split(' '),
            shopperFirstName = fullName[0],
            shopperLastName = fullName[fullName.length - 1];
        var shopperData = {
            firstName: shopperFirstName,
            lastName: shopperLastName,
            email: user.email,
            useLimePayWallet: true
        }
        console.log('creating shopper...');
        LimePay.shoppers.create(shopperData).then(shopper => { 
            if(shopper) {
                const set = setShopper(request.body.userId, shopperData);  
                response.status(200).send(shopper).end();
            } else {
                console.log('something is wrong...');
                response.status(500).send('error. shopper null').end();
            }

        }).catch(error => {
            console.log('something is gravely wrong.');
            console.log(error)
            response.status(500).send(JSON.stringify(error)).end();
        });

    } catch (error) {
        next(error);
    }
});




/* ---------- PAYMENT --------------*/
// Create and sign the fiat payment to create a job
app.post('/fiatPayment', async (request, response, next) => {
    try {
        console.log(request.body)
        //TODO - get the required params from request.body, or hook up to firebase and pass to getFiatData

        // const fiatPaymentData = await getJobCreationData();
        // const createdPayment = await LimePay.fiatPayment.create(fiatPaymentData, signerWalletConfig);
        // response.json({ token: createdPayment.limeToken });
    } catch (error) {
        next(error);
    }
});



/* ---------- EXPRESS INIT --------------*/
const PORT = process.env.PORT || 8080;
app.listen(PORT, async () => {
    LimePay = await LimePaySDK.connect({
        environment: LimePaySDK.Environment[CONFIG.ENV], // LimePaySDK.Environment.Production,
        apiKey: CONFIG.API_KEY,
        secret: CONFIG.API_SECRET
    });
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log(`Sample app listening at http://localhost:` + PORT)
});





/* ----------------- UTILS / HELPERS -----------------*/

// Get firestore
const firestore = () => admin.firestore();

const getJob = (jobId) => {
    return new Promise((resolve, reject) => {
        try {
            const db = firestore();
            var jobRef = db.collection('jobs').doc(jobId);
            jobRef.get().then(doc => {
                if (!doc.exists) {
                    reject('No such document!');
                } else {
                    resolve(doc.data());
                }
            })
        } catch (e) {
            reject(e);
        }
    })
}

const getUser = (userId) => {
    console.log(userId);
    return new Promise((resolve, reject) => {
        try {
            const db = firestore();
            var userRef = db.collection('users').doc(userId);
            userRef.get().then(doc => {
                if (!doc.exists) {
                    reject('No such document!');
                } else {
                    resolve(doc.data());
                }
            })
        } catch (e) {
            reject(e);
        }
    })
}


const getShopper = (userId) => {
    return new Promise((resolve, reject) => {
        try {
            const db = firestore();
            var shopperRef = db.collection('shoppers').doc(userId);
            shopperRef.get().then(doc => {
                if (!doc.exists) {
                    reject('No such document!');
                } else {
                    resolve(doc.data());
                }
            })
        } catch (e) {
            reject(e);
        }
    })
}

const setShopper = (userId, shopper) => {
    return new Promise((resolve, reject) => {
        try {
            const db = firestore();
            db.collection('shoppers').doc(userId).set(shopper, {
                merge: true
            }).then(res => {
                resolve(res)
            }).catch(e => {
                reject(e)
            });
        } catch (e) {
            reject(e);
        }
    })
}

// Get the fiat payment object required for creating the job
const getJobCreationData = async (shopperId, jobTitle, jobPriceUsd, jobPriceCan, jobIdHex, shopperAddress, providerAddress) => {
    jobPriceCan = jobPriceCan * (10 ** 6)

    const gasPriceWei = await getGasPrice();
    let gasPriceBN = ethers.utils.bigNumberify(gasPriceWei);

    let approveGasLimit = 55000
    let approveGasLimitBN = ethers.utils.bigNumberify(approveGasLimit);
    let approveWeiAmount = gasPriceBN.mul(approveGasLimitBN)

    let jobGasLimit = 390000
    let jobGasLimitBN = ethers.utils.bigNumberify(jobGasLimit);
    let jobWeiAmount = gasPriceBN.mul(jobGasLimitBN)

    let totalWeiAmount = jobWeiAmount.add(approveWeiAmount)

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
                functionName: "approve",
                functionParams: [{
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
                functionName: "createJob",
                functionParams: [{
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
    };
};



const getGasPrice = async () => {
    var price = await axios.get(CONFIG.GAS_STATION_URL);
    var parsedPrice = ethers.utils.parseUnits((price.data.fast / 10).toString(10), 'gwei');
    return parsedPrice.toString();
}