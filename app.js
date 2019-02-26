'use strict';
const express = require('express'),
    axios = require('axios'),
    ethers = require('ethers'),
    cors = require('cors'),
    LimePaySDK = require('limepay');
let LimePay;


/* --------- CONFIG------------ */
const signerWallet = require('./signer-wallet');
const sampleShopperWallet = require('./sample-shopper-wallet'); // PASSWORD = sogfiuhsidoufhsdafofd
const CONFIG = require('./config');

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
    origin: ['http://localhost:4200', `https://staging-can-work.firebaseapp.com`, 'https://canwork.io']
}))
app.use((err, request, response, next) => {
    console.log(err);
    response.status(500).send(err);
});

// Basic health check
app.get('/', (req, res) => {
    res
    .status(200)
    .send('Hello, world!')
    .end();
});

/* --------- WALLET / SHOPPER MANAGEMENT ------------ */
// Stub method for creating a shoppers wallet
// Body { password: '<password to generate wallet>' }
app.post('/createWallet', async (request, response, next) => {
    try {
        console.log(request.body)
        //TODO - use limepay SDK to create and store the wallet object, then return it
        response.json({ wallet: sampleShopperWallet });
    } catch (error) {
        next(error);
    }
});

// Stub method for getting shoppers wallet
// Params: shopperId
app.get('/getWallet', async (request, response, next) => {
    try {
        console.log(request.query.shopperId)
        //TODO - get wallet from SDK
        response.json({ wallet: sampleShopperWallet });
    } catch (error) {
        next(error);
    }

});

//TODO - getShopper (https://github.com/LimePay/docs/blob/latest/3.%20JS-SDK-documentation.md#21-getting-shopper)

//TODO - createShopper (https://github.com/LimePay/docs/blob/latest/3.%20JS-SDK-documentation.md#23-creating-shopper)


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

    console.log(`Sample app listening at http://localhost:` + PORT)
});





/* ----------------- UTILS / HELPERS -----------------*/

// Get the fiat payment object required for creating the job
const getJobCreationData = async (jobTitle, jobPriceUsd, jobPriceCan, jobIdHex, shopperAddress, providerAddress) => {
    jobPriceCan  = jobPriceCan * (10 ** 6)

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
        shopper: shopperAddress, 
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
    };
};



const getGasPrice = async () => {
    var price = await axios.get(CONFIG.GAS_STATION_URL);
    var parsedPrice = ethers.utils.parseUnits((price.data.fast / 10).toString(10), 'gwei');
    return parsedPrice.toString();
}