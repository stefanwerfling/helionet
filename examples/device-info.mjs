// Print board + chip + firmware info for a connected helionet modem.
//
// Usage:
//   node examples/device-info.mjs                       # default /dev/ttyACM0
//   node examples/device-info.mjs port=/dev/ttyUSB0     # Heltec V3
//
// Works against any board running firmware 0.4 or newer (older firmwares
// don't implement CMD_INFO and you'll get an "INFO timeout").
import { HelionetDevice } from '../dist/index.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const port = args.port ?? '/dev/ttyACM0';

const dev = new HelionetDevice({ port, rtscts: false });
await dev.open();
try {
    const info = await dev.info();
    console.log(JSON.stringify(info, null, 2));
} finally {
    await dev.close();
}