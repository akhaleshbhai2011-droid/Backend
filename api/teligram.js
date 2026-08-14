// index.js
// Ensure your package.json has "type": "module" to support these imports

import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import { initializeApp } from 'firebase/app';
import { 
    getFirestore, 
    doc, 
    getDoc, 
    setDoc, 
    updateDoc, 
    increment, 
    serverTimestamp,
    collection,
    query,
    where,
    getDocs
} from 'firebase/firestore';

// ==========================================
// 🔥 FIREBASE CONFIGURATION (CLIENT SDK)
// ==========================================
const firebaseConfig = {
    // TODO: Replace with your Firebase Client config
    apiKey: "YOUR_API_KEY",
    authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
    projectId: "YOUR_PROJECT_ID",
    storageBucket: "YOUR_PROJECT_ID.appspot.com",
    messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
    appId: "YOUR_APP_ID"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// ==========================================
// 🔥 BOT & EXPRESS SERVER SETUP
// ==========================================
const token = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const bot = new TelegramBot(token, { polling: true });

const expressApp = express();
const port = process.env.PORT || 3000;

expressApp.get('/', (req, res) => res.send('Bot Backend is running successfully!'));
expressApp.listen(port, () => console.log(`Server started on port ${port}`));

// ==========================================
// 🔥 REQUIRED DATABASE FUNCTIONS
// ==========================================

async function createOrEnsureUser(userId, firstName, photoURL, referralId) {
    const userRef = doc(db, 'users', userId.toString());
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
        await setDoc(userRef, {
            id: userId.toString(),
            name: firstName,
            photoURL: photoURL || "",
            coins: 0,
            reffer: 0, // Typo preserved as per your structure requirements
            refferBy: referralId || null,
            tasksCompleted: 0,
            totalWithdrawals: 0,
            frontendOpened: false,
            rewardGiven: false
        }, { merge: true });
        console.log(`New user created: ${userId} (Referred by: ${referralId || 'None'})`);
    } else {
        // Just update name/photo if they already exist, don't overwrite referral fields
        await setDoc(userRef, {
            name: firstName,
            photoURL: photoURL || userSnap.data().photoURL
        }, { merge: true });
    }
}

async function updateField(userId, field, value) {
    const userRef = doc(db, 'users', userId.toString());
    await updateDoc(userRef, { [field]: value });
}

async function incrementField(userId, field, amount) {
    const userRef = doc(db, 'users', userId.toString());
    await updateDoc(userRef, { [field]: increment(amount) });
}

async function rewardReferrer(userId) {
    try {
        const userRef = doc(db, 'users', userId.toString());
        const userSnap = await getDoc(userRef);
        
        if (!userSnap.exists()) return;
        const data = userSnap.data();

        // Safety check to avoid double-rewarding
        if (data.rewardGiven === true || !data.refferBy) return;

        const REWARD_AMOUNT = 500;
        const referrerId = data.refferBy.toString();

        // 1) Set rewardGiven = true immediately on the referred user
        await updateField(userId, 'rewardGiven', true);

        // 2) Increment Referrer's stats
        await incrementField(referrerId, 'coins', REWARD_AMOUNT);
        await incrementField(referrerId, 'reffer', 1);

        // 3) Create Ledger in ref_rewards/{B}
        const rewardLedgerRef = doc(db, 'ref_rewards', userId.toString());
        await setDoc(rewardLedgerRef, {
            userId: userId.toString(),
            referrerId: referrerId,
            reward: REWARD_AMOUNT,
            createdAt: serverTimestamp()
        });

        console.log(`Referral processed: User ${userId} rewarded Referrer ${referrerId}`);
    } catch (error) {
        console.error(`Error processing reward for ${userId}:`, error);
    }
}

// ==========================================
// 🔥 TELEGRAM BOT HANDLER (/start)
// ==========================================
bot.onText(/^\/start(?: (.*))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const firstName = msg.from.first_name || 'User';
    
    // Extract referral code if present
    const referralId = match[1] || null;

    // Attempt to grab Telegram Profile Photo
    let photoURL = "";
    try {
        const profiles = await bot.getUserProfilePhotos(msg.from.id, { limit: 1 });
        if (profiles.total_count > 0) {
            const fileId = profiles.photos[0][0].file_id;
            const file = await bot.getFile(fileId);
            photoURL = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
        }
    } catch (err) {
        console.error("Could not fetch profile photo:", err.message);
    }

    // Initialize or Merge User in Firestore (DOES NOT GIVE REWARD YET)
    await createOrEnsureUser(userId, firstName, photoURL, referralId);

    // Prepare Welcome Message
    const imageUrl = "https://i.ibb.co/6JsvTN3C/uploaded-image.jpg";
    const caption = `👋 Hi! Welcome ${firstName} ⭐\nYaha aap tasks complete karke real rewards kama sakte ho!\n\n🔥 Daily Tasks\n🔥 Video Watch\n🔥 Mini Apps\n🔥 Referral Bonus\n🔥 Auto Wallet System\n\nReady to earn?\nTap START and your journey begins!`;
    
    const inlineKeyboard = {
        inline_keyboard: [
            [{ text: "▶ Open App", web_app: { url: "https://akhaleshbhai2011-droid.github.io/Rox-Task-Bot/" } }],
            [{ text: "📢 Channel", url: "https://t.me/earningservice007" }],
            [{ text: "🌐 Community", url: "https://t.me/earningservice007" }]
        ]
    };

    // Send Message
    await bot.sendPhoto(chatId, imageUrl, {
        caption: caption,
        reply_markup: inlineKeyboard
    });
});

// ==========================================
// 🔥 REFERRAL REWARD WORKER (Interval-based)
// ==========================================
// Runs every 5 seconds to check for users who opened the frontend 
// but haven't given their referrer the reward yet.
setInterval(async () => {
    try {
        const usersRef = collection(db, 'users');
        // Query users where frontendOpened = true AND rewardGiven = false
        // Note: This requires a composite index in Firestore!
        const q = query(
            usersRef, 
            where('frontendOpened', '==', true), 
            where('rewardGiven', '==', false)
        );

        const snapshot = await getDocs(q);

        snapshot.forEach(async (docSnap) => {
            const data = docSnap.data();
            
            if (data.refferBy) {
                // If they have a referrer, grant the reward
                await rewardReferrer(docSnap.id);
            } else {
                // If they don't have a referrer, just mark as given to stop querying them
                await updateField(docSnap.id, 'rewardGiven', true);
            }
        });
    } catch (error) {
        // Note: If you see an error here about missing composite indexes, 
        // click the URL provided in the Firebase error console to create it.
        console.error("Worker Interval Error:", error.message);
    }
}, 5000); // 5000ms = 5 seconds

console.log("Bot Backend successfully initialized and worker started.");
