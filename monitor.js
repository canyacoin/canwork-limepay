const schedule = require('node-schedule');
const FirestoreService = require('./firestore-service')
const moment = require('moment');
const ethers = require('ethers');

const EVERY_THREE_SECONDS = "*/3 * * * * *";

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
        console.log(`Starting monitoring payment with id: ${paymentId}`);

        // The function is being executed every 3 seconds until `successful` or `failed` status is retrieved
        const scheduledJob = schedule.scheduleJob(paymentId, EVERY_THREE_SECONDS, async () => {
            try {
                // GET the payment from LimePay
                const result = await this.limepay.payments.get(paymentId);

                // Update the status of the Payment in firestore
                const paymentInDB = await FirestoreService.getPayment(paymentId);
                await FirestoreService.setPayment({ ...paymentInDB, status: result.status });

                // Get the Job from DB
                let job = await FirestoreService.getJob(paymentInDB.jobId);

                if (shouldAddEscrowActionLog(job, paymentInDB, result)) {
                    await updateAuthoriseEscrowActionLog(job, paymentInDB, result.genericTransactions[0]);
                }

                // Stop the monitoring of the status is Successful or Failed
                if (result.status === PAYMENT_STATUSES.SUCCESSFUL || result.status === PAYMENT_STATUSES.FAILED) {
                    // Stop the monitoring of the payment
                    console.log(`Stopping monitoring of payment with ID ${paymentId}, for Job with ID ${paymentInDB.jobId}. Status is ${result.status}`);
                    scheduledJob.cancel();

                    saveTransactionHash(paymentInDB, result);

                    if (result.status === PAYMENT_STATUSES.SUCCESSFUL) {
                        await updateState(job, paymentInDB);
                        await updateActionLog(job, paymentInDB);
                    }
                }
            } catch (error) {
                console.log(`An error occured while monitoring payment with ID ${paymentId}. Error: ${error}`);
            }
        });

    }

}

module.exports = Monitor;

/**
 * @name updateState
 * @description Updates the state of the Job to the next one. If job creation -> 'Funds In Escrow'. if job completion -> `Complete`
 * @param {object} payment 
 */
const updateState = async function (job, payment) {
    if (payment.type === PAYMENT_TYPES.JOB_CREATION) {
        job.state = 'Funds In Escrow';
    } else if (payment.type === PAYMENT_TYPES.JOB_COMPLETION) {
        job.state = 'Complete';
    }
    await FirestoreService.setJob(job);
    console.log(`updated job state`, job.state);
}

/**
 * @name updateActionLog
 * @description Updates the action log of the Job. If job creation -> 'Authorise escrow'. if job completion -> `Complete job`
 * @param {object} payment
 * @param {object} job
 */
const updateActionLog = async function (job, payment) {

    let actionLog = { timestamp: moment().format('x'), message: '', executedBy: 'User', private: false };
    if (payment.type === PAYMENT_TYPES.JOB_CREATION) {
        Object.assign(actionLog, { type: 'Send CAN to escrow' });
    } else if (payment.type === PAYMENT_TYPES.JOB_COMPLETION) {
        Object.assign(actionLog, { type: 'Complete job'});
    }
    console.log("actionLog:", actionLog);

    job.actionLog.push(actionLog);
    await FirestoreService.setJob(job);
}

const updateAuthoriseEscrowActionLog = async function (job, paymentInDB, transaction) {
    const actionLog = {
        timestamp: moment().format('x'),
        amountCan: convertWithDecimals(transaction.functionParams[1].value),
        type: 'Authorise escrow',
        executedBy: 'User',
        message: '',
        private: true
    };
    console.log("actionLog:", actionLog);
    job.actionLog.push(actionLog);
    await FirestoreService.setJob(job);
}


const saveTransactionHash = async function (paymentInDb, limePayPayment) {
    // If the payment is Job creation, we have 2 transactions. Approve and CreateJob. We want to save the CreateJob hash
    if (paymentInDb.type === PAYMENT_TYPES.JOB_CREATION) {
        paymentInDb.txHash = limePayPayment.genericTransactions[1].transactionHash;
    } else if (paymentInDb.type === PAYMENT_TYPES.JOB_COMPLETION) {
        // If the payment is Job completion, we have 1 transaction - CompleteJob
        paymentInDb.txHash = limePayPayment.genericTransactions[0].transactionHash;
    }
    await FirestoreService.setPayment(paymentInDb);
}


// Converts the Amount of CAN tokens to their base. CAN token has 6 decimals. 
const convertWithDecimals = function (amount) {
    const amountInBN = ethers.utils.bigNumberify(amount);
    return ethers.utils.formatUnits(amountInBN, 6).toString();
}

function shouldAddEscrowActionLog(job, paymentInDB, result) {
    const lastActionLog = job.actionLog[job.actionLog.length - 1];

    // Check whether we already added the escrow action log
    if (lastActionLog.type != 'Authorise escrow') { 
        return paymentInDB.type === PAYMENT_TYPES.JOB_CREATION && result.genericTransactions[0].status === PAYMENT_STATUSES.SUCCESSFUL;
    }
    return false;
}
