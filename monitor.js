const schedule = require('node-schedule');
const FirestoreService = require('./firestore-service')
const moment = require('moment');
const ethers = require('ethers');

const EVERY_THREE_SECONDS = "*/3 * * * * *";

const TRANSACTION_STATUSES = require('./constants.json').TRANSACTION_STATUSES;
const PAYMENT_STATUSES = require('./constants.json').PAYMENT_STATUSES;
const PAYMENT_TYPES = require('./constants.json').PAYMENT_TYPES;

class Monitor {

    constructor(limepay) {
        this.limepay = limepay;
    }

    /**
     * @name monitor
     * @summary Pings the LimePay api every 3 seconds for a payment and updates his status
     * @description Uses node-scheduler to schedule jobs that execute every 3 seconds until a payment goes into `Successful` or `Failed` state
     * @param {string} paymentId LimePay payment ID
     */
    monitor(paymentId) {
        console.log(`Started monitoring payment with id: ${paymentId}`);

        // The function is being executed every 3 seconds until `successful` or `failed` status is retrieved
        const scheduledJob = schedule.scheduleJob(paymentId, EVERY_THREE_SECONDS, async () => {
            try {
                // GET the payment from LimePay
                const retrievedPayment = await this.limepay.payments.get(paymentId);

                // Get the Payment from DB
                const paymentInDB = await FirestoreService.getPayment(paymentId);
                // Get the Job from DB
                let job = await FirestoreService.getJob(paymentInDB.jobId);

                if (isJobCreation(paymentInDB.type)) {
                    await updateJobCreationPayment(job, paymentInDB, retrievedPayment);
                } else if (isJobCompletion(paymentInDB.type)) {
                    await updateJobCompletionPayment(job, paymentInDB, retrievedPayment);
                } else {
                    throw 'Invalid payment type';
                }

                // Stop the monitoring of the status is Successful or Failed
                if (isTerminalStatus(retrievedPayment.status)) {
                    // Stop the monitoring of the payment
                    console.log(`Stopping monitoring of payment with ID ${paymentId}, for Job with ID ${paymentInDB.jobId}. Status is ${retrievedPayment.status}`);
                    scheduledJob.cancel();
                }

            } catch (error) {
                console.log(`An error occured while monitoring payment with ID ${paymentId}. Error: ${error}`);
            }
        });

    }

}

module.exports = Monitor;

/**
 * @name isJobCreation
 * @param {String} type
 * @description Returns true if the type of the payment is JOB_CREATION 
 */
const isJobCreation = function (type) {
    return type === PAYMENT_TYPES.JOB_CREATION;
}

/**
 * @name isJobCompletion
 * @param {String} type
 * @description Returns true if the type of the payment is JOB_CREATION 
 */
const isJobCompletion = function (type) {
    return type === PAYMENT_TYPES.JOB_COMPLETION;
}

/**
 * @name updateJobCreationPayment
 * @param {Object} job 
 * @param {Object} paymentInDB
 * @param {object} retrievedPayment
 * @summary Updates the state of the job and Create Job payment in the DB depending on the progress 
 */
const updateJobCreationPayment = async function (job, payment, retrievedPayment) {
    const approveTx = retrievedPayment.genericTransactions[0];
    const createJobTx = retrievedPayment.genericTransactions[1];
    
    // 1. Update Approve Transction Data
    updateApproveTransactionData(approveTx, payment, job);

    // 2. Update CreateJob transaction Data
    updateCreateJobTxData(createJobTx, payment, job);
    
    // 3. Update Payment State
    payment.status = retrievedPayment.status;
    await FirestoreService.setPayment(payment);

    // 4. Update Job State on success
    if (payment.status == PAYMENT_STATUSES.SUCCESSFUL) {
        job.state = 'Funds In Escrow';
    }
    await FirestoreService.setJob(job);
}


/**
 * @name updateJobCompletionPayment
 * @param {Object} job
 * @param {Object} paymentInDB
 * @summary Updates the state of the job and Complete Job payment in the DB depending on the progress
 */
const updateJobCompletionPayment = async function (job, payment, retrievedPayment) {
    const completeJobTX = retrievedPayment.genericTransactions[0];

    if (isTransactionBroadcasted(completeJobTX)) {
        appendCompleteJobTX(payment, completeJobTX);
    }
    else if (isTransactionMined(completeJobTX)) {
        // Safety check. If we missed an update and did not added the approve transaction.
        safetyCheckCompleteTx(payment, completeJobTX);

        // Update transaction success to true
        updateTransactionByHash(payment, completeJobTX.transactionHash, true, false);

        // // Adds new Job Action when Approve TX is mined
        if (shouldAddCompleteJobActionLog(job, completeJobTX)) {
            appendCompleteJobActionLog(job);
            console.log(`Complete Job TX for payment [${payment.id}] was mined. TX hash: ${completeJobTX.transactionHash}`);
        }
    }
    else if (isTransactionReverted(completeJobTX)) {
        // Safety check. If we missed an update and did not added the approve transaction.
        safetyCheckCompleteTx(payment, completeJobTX);

        // Update transaction failure to true
        updateTransactionByHash(payment, completeJobTX.transactionHash, false, true);
        console.log(`Complete Job TX for payment [${payment.id}] has reverted. TX hash: ${completeJobTX.transactionHash}`);
    }

    // 3. Update Payment State
    payment.status = retrievedPayment.status;
    await FirestoreService.setPayment(payment);

    // 4. Update Job State on success
    if (payment.status == PAYMENT_STATUSES.SUCCESSFUL) {
        job.state = 'Complete';
    }
    await FirestoreService.setJob(job);
}

// ------------- Main Functions -----------------

function updateCreateJobTxData(createJobTx, payment, job) {
    if (isTransactionBroadcasted(createJobTx)) {
        appendCreateJobTx(payment, createJobTx);
    }
    else if (isTransactionMined(createJobTx)) {
        // Safety check. If we missed an update and did not added the createJob transaction.
        safetyCheckCreateJobTx(payment, createJobTx);
        
        //Update transaction success to true
        updateTransactionByHash(payment, createJobTx.transactionHash, true, false);

        // Add new Job Action when CreateJob TX is mined
        if (shouldAddSendCANActionLog(job, createJobTx)) {
            appendSendCANActionLog(job);
            console.log(`Create Job TX for payment [${payment.id}] was mined. TX hash: ${createJobTx.transactionHash}`);
        }
    }
    else if (isTransactionReverted(createJobTx)) {
        // Safety check. If we missed an update and did not added the createJob transaction.
        safetyCheckCreateJobTx(payment, createJobTx);

        //Update transaction failure to true
        updateTransactionByHash(payment, createJobTx.transactionHash, false, true);
        console.log(`Create Job TX for payment [${payment.id}] rhas everted. TX hash: ${createJobTx.transactionHash}`);
    }
}

function updateApproveTransactionData(approveTx, payment, job) {
    if (isTransactionBroadcasted(approveTx)) {
        appendApproveTransaction(payment, approveTx);
    }
    else if (isTransactionMined(approveTx)) {
        // Safety check. If we missed an update and did not added the approve transaction.
        safetyCheckApproveTx(payment, approveTx);
        
        // Update transaction success to true
        updateTransactionByHash(payment, approveTx.transactionHash, true, false);
        
        // Adds new Job Action when Approve TX is mined
        if (shouldAddEscrowActionLog(job, approveTx)) {
            appendAuthoriseEscrowActionLog(job, approveTx);
            console.log(`Approve TX for payment [${payment.id}] mined. TX hash: ${approveTx.transactionHash}`);
        }
    }
    else if (isTransactionReverted(approveTx)) {
        // Safety check. If we missed an update and did not added the approve transaction.
        safetyCheckApproveTx(payment, approveTx);
        // Update transaction failure to true
        updateTransactionByHash(payment, approveTX.transactionHash, false, true);
        console.log(`Approve TX for payment [${payment.id}] reverted. TX hash: ${approveTx.transactionHash}`);
    }
}

// ------------- Main Functions -----------------

// ------------- Transaction Functions ----------

// Safety check. If we missed an update and did not added the approve transaction.
function safetyCheckApproveTx(payment, approveTx) {
    if (payment.transactions == undefined || !findTransactionByHash(payment, approveTx.transactionHash)) {
        appendApproveTransaction(payment, approveTx);
    }
}

// Safety check. If we missed an update and did not added the create job transaction.
function safetyCheckCreateJobTx(payment, createJobTx) {
    if (!findTransactionByHash(payment, createJobTx.transactionHash)) {
        appendCreateJobTx(payment, createJobTx);
    }
}

// Safety check. If we missed an update and did not added the complete job transaction.
function safetyCheckCompleteTx(payment, completeJobTX) {
    if (payment.transactions == undefined || !findTransactionByHash(payment, completeJobTX.transactionHash)) {
        appendCompleteJobTX(payment, completeJobTX);
    }
}

// Adds the Approve transaction info into limepay-payment entry 
function appendApproveTransaction(payment, approveTransaction) {
    if (payment.transactions) {
        const approveTX = findTransactionByHash(payment, approveTransaction.transactionHash);
        // Transaction is already added in transactions array. Will skip adding it again
        if (approveTX) return;
    } else {
        payment.transactions = [];
        const transaction = createNewTransaction(approveTransaction.transactionHash, 'Authorise escrow');
        payment.transactions.push(transaction);
        console.log(`Approve TX for payment [${payment.id}] broadcasted. TX hash: ${approveTransaction.transactionHash}`);
    }
}

// Adds the CreateJob transaction into limepay-payment entry
function appendCreateJobTx(payment, createJobTransactionFromLP) {
    const createJobTx = findTransactionByHash(payment, createJobTransactionFromLP.transactionHash);
    // Transaction is already added in transactions array. Will skip adding it again
    if (createJobTx) return;

    const transaction = createNewTransaction(createJobTransactionFromLP.transactionHash, 'Send CAN to escrow');
    payment.transactions.push(transaction);
    console.log(`Create Job TX for payment [${payment.id}] was broadcasted. TX hash: ${createJobTransactionFromLP.transactionHash}`);
}

// Adds the Complete Job transaciton info into limepay-payment entry
function appendCompleteJobTX(payment, completeJobTX) {
    if (payment.transactions) {
        const completeJob = findTransactionByHash(payment, completeJobTX.transactionHash);
         // Transaction is already added in transactions array. Will skip adding it again
        if (completeJob) return;
    } else {
        payment.transactions = [];
        const transaction = createNewTransaction(completeJobTX.transactionHash, 'Complete job');
        payment.transactions.push(transaction);
        console.log(`Complete Job TX for payment [${payment.id}] was broadcasted. TX hash: ${completeJobTX.transactionHash}`);
    }
}

// Finds a given transaciton by its transaction hash
function findTransactionByHash(payment, transactionHash) {
    return payment.transactions.find(tx => { return tx.hash === transactionHash; });
}

function updateTransactionByHash(payment, transactionHash, success, failure) {
    const tx = findTransactionByHash(payment, transactionHash);
    tx.success = success;
    tx.failure = failure;
}

function isTerminalStatus(status) {
    return status === PAYMENT_STATUSES.SUCCESSFUL || status === PAYMENT_STATUSES.FAILED;
}

// Create new transaction object
function createNewTransaction(transactionHash, actionType) {
    return {
        hash: transactionHash,
        actionType: actionType,
        failure: false,
        success: false,
        timestamp: moment().format('x')
    };
}

// ------------- Transaction Functions ----------


// -------------- Job Actions ------------------- 

const appendAuthoriseEscrowActionLog = function (job, transaction) {
    let action = createNewAction('Authorise escrow', true);
    action.amountCan = convertWithDecimals(transaction.functionParams[1].value);

    console.log("actionLog:", action);
    job.actionLog.push(action);
}

const appendSendCANActionLog = function (job) {
    const action = createNewAction('Send CAN to escrow', false);
    console.log('ActionLog:', action);
    job.actionLog.push(action);
}

const appendCompleteJobActionLog = function (job) {
    let action = createNewAction('Complete job', false);
    console.log("actionLog:", action);
    job.actionLog.push(action);
}

const createNewAction = function (type, private, executedBy = 'User') {
    const action = {
        type,
        timestamp: moment().format('x'),
        message: '',
        private,
        executedBy
    }
    return action;
}

// Updates the Job action log when the approve transaction is mined
function shouldAddEscrowActionLog(job, transaction) {
    const lastActionLog = job.actionLog[job.actionLog.length - 1];
    // Check whether we already added the escrow action log
    return lastActionLog.type == 'Accept terms' && transaction.status === PAYMENT_STATUSES.SUCCESSFUL;
}

// Updates the Job action log when the approve transaction is mined
function shouldAddSendCANActionLog(job, transaction) {
    const lastActionLog = job.actionLog[job.actionLog.length - 1];
    // Check whether we already added the escrow action log
    return lastActionLog.type == 'Authorise escrow' && transaction.status === PAYMENT_STATUSES.SUCCESSFUL;
}

// Updates the Job action log when the approve transaction is mined
function shouldAddCompleteJobActionLog(job, transaction) {
    const lastActionLog = job.actionLog[job.actionLog.length - 1];
    // Check whether we already added the escrow action log
    return lastActionLog.type != 'Complete job' && transaction.status === PAYMENT_STATUSES.SUCCESSFUL;
}

// -------------- Job Actions -------------- 



// -------------- UTILS --------------------

// Returns true if the transaction is broadcasted
function isTransactionBroadcasted(transaction) {
    return transaction.status === TRANSACTION_STATUSES.PROCESSING && transaction.transactionHash;
}

// Returns true if the transaction is mined
function isTransactionMined(transaction) {
    return transaction.status === TRANSACTION_STATUSES.SUCCESSFUL && transaction.transactionHash;
}

// Returns true if the transaction has reverted
function isTransactionReverted(transaction) {
    return transaction.status === TRANSACTION_STATUSES.FAILED && transaction.transactionHash;
}

// Converts the Amount of CAN tokens to their base. CAN token has 6 decimals. 
const convertWithDecimals = function (amount) {
    const amountInBN = ethers.utils.bigNumberify(amount);
    return ethers.utils.formatUnits(amountInBN, 6).toString();
}

// -------------- UTILS --------------------

