const schedule = require('node-schedule');
const FirestoreService = require('./firestore-service')
const EVERY_THREE_SECONDS = "*/3 * * * * *";

const PAYMENT_STATUSES = {
    NEW : "NEW",
    PROCESSING: "PROCESSING",
    SUCCESSFUL: "SUCCESSFUL",
    FAILED: "FAILED",
}

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

                    // TODO should we update the Job with ActionLog
                }
            } catch (error) {
                console.log(`An error occured while monitoring payment with ID ${paymentId}. Error: ${JSON.stringify(error)}`);
            }
        });

    }

}

module.exports = Monitor;