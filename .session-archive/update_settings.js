const fs = require('fs');
const path = require('path');

const settingsPath = path.join(process.env.USERPROFILE, '.pi', 'agent', 'settings.json');
console.log('Settings path:', settingsPath);

try {
  const raw = fs.readFileSync(settingsPath, 'utf8');
  const settings = JSON.parse(raw);
  if (!settings.packages) {
    settings.packages = [];
  }
  const pkg = 'git:github.com/JasonLandbridge/pi-omniroute-sync';
  if (!settings.packages.includes(pkg)) {
    settings.packages.push(pkg);
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  console.log('Successfully updated settings.json with:', pkg);
  console.log(fs.readFileSync(settingsPath, 'utf8'));
} catch (err) {
  console.error('Error updating settings:', err);
  process.exit(1);
}
