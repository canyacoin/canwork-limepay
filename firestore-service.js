const admin = require('firebase-admin');

/**
 * @function @name firestore
 * @returns Admin firestore used to read and write data
 */
const firestore = () => admin.firestore()

/**
 * @function @name getJob
 * @summary Get job from firestore based on ID
 * @param jobId -- string
 */
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

/**
 * @function @name setJob
 * @summary Update the job object in firestore
 * @param job -- updated job object
 */
const setJob = (job) => {
    return new Promise((resolve, reject) => {
        try {
            const db = firestore()
            db.collection('jobs').doc(job.id).set(job, { merge: true }).then(res => {
                resolve(res)
            }).catch(e => {
                reject(e)
            })
        } catch (e) {
            reject(e)
        }
    })
}

/**
 * @function @name getUser
 * @summary Get user from firestore based on ID
 * @param userId -- string
 */
const getUser = (userId) => {
    console.log(userId)
    return new Promise((resolve, reject) => {
        try {
            const db = firestore()
            var userRef = db.collection('users').doc(userId)
            userRef.get().then(doc => {
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
                resolve({ ...shopper, shopperId })
            }
        } catch (e) {
            reject(e)
        }
    })
}

/**
 * @function @name SetShopper
 * @summary Sets the limepay shopper ID in firestore so we know who has an existing acc
 * @param {String} userId -- string
 * @param {object} shopper -- object ((shopperId))
 */
const setShopper = (userId, shopper) => {
    return new Promise((resolve, reject) => {
        try {
            const db = firestore()
            db.collection('shoppers').doc(userId).set(shopper, {
                merge: true
            }).then(res => {
                resolve(res)
            }).catch(e => {
                reject(e)
            })
        } catch (e) {
            reject(e)
        }
    })
}

module.exports = {
    getJob,
    getPayment,
    setJob,
    getUser,
    getShopper,
    setShopper,
    firestore
}