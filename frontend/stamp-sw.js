// Runs in the Vercel build: gives the service worker a new id on every deployment, which is what
// makes browsers detect an update and clear the previous version's caches.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'public', 'firebase-messaging-sw.js');
const id = (process.env.VERCEL_GIT_COMMIT_SHA || String(Date.now())).slice(0, 12);
fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('__BUILD_ID__').join(id));
console.log('service worker build id:', id);
