'use strict';
const { app } = require('electron');
const path = require('node:path');

// Retain the internal name so existing desktop user-data directories stay in use.
app.setName('同频');
// Tests can override the path to keep desktop profiles isolated from real usage.
if (process.env.TEAMRELAY_PROFILE) app.setPath('userData', path.resolve(process.env.TEAMRELAY_PROFILE));
require('./shell.cjs').startDesktop(require('electron'));
// HTTPS certificate errors retain Electron's default rejection; never bypass TLS.
