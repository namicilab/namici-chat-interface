// PM2 process file for namici-ci.
//
//   npm run build
//   pm2 start ecosystem.config.js
//   pm2 save && pm2 startup     # survive a reboot
//
// The port lives here only. `next start` reads PORT from the environment, so
// there is one place to change it rather than a port baked into package.json
// that disagrees with this file.

const path = require('path');

module.exports = {
  apps: [
    {
      name: 'namici-ci',
      cwd: __dirname,

      // Call Next's binary directly rather than going through `npm start`.
      // The npm shim sits between PM2 and the real process, which makes
      // `pm2 restart` and `pm2 stop` leave orphans behind.
      script: path.join(__dirname, 'node_modules', 'next', 'dist', 'bin', 'next'),
      args: 'start',
      interpreter: 'node',

      exec_mode: 'fork',
      instances: 1,

      autorestart: true,
      watch: false,
      max_memory_restart: '512M',

      // A crash loop should give up rather than hammer the box forever.
      max_restarts: 10,
      min_uptime: '20s',
      restart_delay: 2000,

      env: {
        NODE_ENV: 'production',
        PORT: 3009,
        HOSTNAME: '0.0.0.0',
      },

      error_file: path.join(__dirname, 'logs', 'error.log'),
      out_file: path.join(__dirname, 'logs', 'out.log'),
      merge_logs: true,
      time: true,
    },
  ],
};
