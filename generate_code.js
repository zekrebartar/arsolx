require('dotenv').config();
const { MongoClient } = require('mongodb');
const readline = require('readline');

const uri = process.env.MONGO_URI;
const client = new MongoClient(uri);

function generateUniqueCode(length = 10) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

async function createCode(durationDays) {
    try {
        await client.connect();
        const db = client.db("arsolx");
        const codesCollection = db.collection("codes");

        const code = generateUniqueCode(10);
        const now = new Date();

        const newCode = {
            code: code,
            created_at: now,
            expire_duration: durationDays,
            is_used: 0,
            used_by: null
        };

        await codesCollection.insertOne(newCode);
        console.log(`✅ Unique code generated: ${code} for ${durationDays}-day subscription`);
    } catch (err) {
        console.error('❌ Error:', err);
    } finally {
        await client.close();
        process.exit(0);
    }
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

rl.question('How many days subscription (15, 30, 60)? ', (answer) => {
    const days = parseInt(answer);
    if ([15, 30, 60].includes(days)) {
        createCode(days);
    } else {
        console.log('❌ Invalid input. Please enter 15, 30, or 60.');
        rl.close();
        process.exit(1);
    }
});
