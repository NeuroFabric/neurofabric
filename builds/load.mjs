const end = Date.now() + Number(process.argv[2] ?? 60) * 1000;
let x = 0;
while (Date.now() < end) { for (let i = 0; i < 2e6; i++) x += Math.sqrt(i); }
