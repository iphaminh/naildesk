// NailDesk — server entry (Hostinger Node.js hosting or any Node host).
// Runs Dream Nails & Spa: the booking page at /, the check-in kiosk at /kiosk
// and the front-desk POS at /admin.
const path = require('path');
const express = require('express');
const app = require('./api/index');

app.use(express.static(path.join(__dirname, 'public')));
app.get('/kiosk', (req, res) => res.sendFile(path.join(__dirname, 'public', 'kiosk.html')));
// NailMind is its own product on its own domain now. Links, bookmarks and
// printed QR codes that still point here land on the real studio, not a 404.
app.get('/nailmind', (req, res) => res.redirect(302, 'https://nailmind.app/app'));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NailDesk running on port ${PORT}`));
