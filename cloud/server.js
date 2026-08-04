// Dream Nails POS — server entry (Hostinger Node.js hosting or any Node host).
// The same Express app also works as a Vercel serverless function (api/index.js).
const path = require('path');
const express = require('express');
const app = require('./api/index');

app.use(express.static(path.join(__dirname, 'public')));
app.get('/kiosk', (req, res) => res.sendFile(path.join(__dirname, 'public', 'kiosk.html')));
app.get('/nailmind', (req, res) => res.sendFile(path.join(__dirname, 'public', 'nailmind.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dream Nails POS running on port ${PORT}`));
