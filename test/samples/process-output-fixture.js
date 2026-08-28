const [mode, arg1, arg2, ...rest] = process.argv.slice(2);

switch (mode) {
  case 'ticks': {
    const intervalMs = Number(arg1 ?? 200);
    const count = Number(arg2 ?? 6);
    let i = 0;
    const timer = setInterval(() => {
      console.log(`tick${i++}`);
      if (i >= count) {
        clearInterval(timer);
      }
    }, intervalMs);
    break;
  }
  case 'lines': {
    const count = Number(arg1 ?? 10);
    const prefix = arg2 ?? 'line';
    for (let i = 0; i < count; i++) console.log(`${prefix}${i}`);
    break;
  }
  case 'delayed': {
    const delayMs = Number(arg1 ?? 500);
    const message = [arg2, ...rest].filter(Boolean).join(' ') || 'done';
    setTimeout(() => console.log(message), delayMs);
    break;
  }
  case 'immediate': {
    const message = [arg1, arg2, ...rest].filter(Boolean).join(' ') || 'done';
    console.log(message);
    break;
  }
  default:
    console.error(`Unknown fixture mode: ${mode ?? '(missing)'}`);
    process.exitCode = 2;
}
