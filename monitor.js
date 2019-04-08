const schedule = require('node-schedule');
const FirestoreService = require('./firestore-service')
const moment = require('moment');

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

                // Stop the monitoring of the status is Successful or Failed
                if (result.status === PAYMENT_STATUSES.SUCCESSFUL || result.status === PAYMENT_STATUSES.FAILED) {
                    // Stop the monitoring of the payment
                    console.log(`Stopping monitoring of payment with ID ${paymentId}, for Job with ID ${paymentInDB.jobId}. Status is ${result.status}`);
                    scheduledJob.cancel();

                    saveTransactionHash(paymentInDB, result);

                    if (result.status === PAYMENT_STATUSES.SUCCESSFUL) {
                        await updateState(paymentInDB);
                        await updateActionLog(paymentInDB);
                    }
                }
            } catch (error) {
                console.log(`An error occured while monitoring payment with ID ${paymentId}. Error: ${JSON.stringify(error)}`);
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
const updateState = async function (payment) {
    let job = await FirestoreService.getJob(payment.jobId);
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
const updateActionLog = async function (payment) {
    let job = await FirestoreService.getJob(payment.jobId);

    let actionLog = { timestamp: moment().format('x'), message: ''};
    if (payment.type === PAYMENT_TYPES.JOB_CREATION) {
        Object.assign(actionLog, { type: 'Authorise escrow', executedBy: 'Client', private: true });
    } else if (payment.type === PAYMENT_TYPES.JOB_COMPLETION) {
        Object.assign(actionLog, { type: 'Complete job', executedBy: 'User', private: false });
    }
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