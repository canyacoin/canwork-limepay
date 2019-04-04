const schedule = require('node-schedule');
const db = require('firebase-admin').firestore();

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

    async monitor(paymentId) {
        // Check if we are already monitoring the payment. If not -> start
        const payment = await getPayment(paymentId);
        if (payment) {
            console.log(`Monitor is already listening for payment with id: ${paymentId}`);
        } else {
            console.log(`Starting monitoring payment with id: ${paymentId}`);
            const job = schedule.scheduleJob(paymentId, EVERY_THREE_SECONDS, async () => {
                
                // GET the payment from LimePay
                const payment = await this.limepay.payments.get(paymentId);
                
                // Stop the monitoring if the status is Successful or Failed
                if (payment.status === PAYMENT_STATUSES.SUCCESSFUL || payment.status === PAYMENT_STATUSES.FAILED) {
                    // Stop monitoring
    
                    console.log(``);
                    job.cancel();
                }
    
            });
        }

    }

}

/**
 * @function @name getPayment
 * @summary Get payment from firestore based on ID
 * @param paymentId -- string
 */
const getPayment = (paymentId) => {
    return new Promise((resolve, reject) => {
        try {
            var paymentRef = db.collection('payments').doc(paymentId)
            paymentRef.get().then(doc => {
                if (!doc.exists) {
                    resolve(null);
                } else {
                    resolve(doc.data())
                }
            })
        } catch (e) {
            reject(e)
        }
    })
}



module.exports = Monitor;