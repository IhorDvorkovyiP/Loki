// Дописує нові рядки в live_test.log кожну секунду
// node live_writer.js
const fs   = require('fs');
const path = require('path');

const LOG = path.join(__dirname, 'live_test.log');
const LEVELS = ['INFO', 'INFO', 'INFO', 'WARN', 'ERROR'];
const COMPS  = ['HTTP', 'SLAVE', 'BUS', 'FRONT', 'MASTER'];
const DIRS   = ['>>>', '<--', '>>'];

let counter = 1;

function pad(n) { return String(n).padStart(2, '0'); }
function now() {
  const d = new Date();
  return `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function traceId() { return '#' + Math.random().toString(16).slice(2, 10); }

setInterval(() => {
  const lvl  = rand(LEVELS);
  const comp = rand(COMPS);
  const dir  = rand(DIRS);
  const line = `${now()} ${lvl} ${traceId()}: ${comp} ${dir} {"seq":${counter},"msg":"live update","ts":${Date.now()}}\n`;
  fs.appendFileSync(LOG, line);
  console.log(`[${counter}] appended: ${lvl} ${comp} ${dir}`);
  counter++;
}, 1000);

console.log(`Writing to: ${LOG}`);
console.log('Ctrl+C to stop');
