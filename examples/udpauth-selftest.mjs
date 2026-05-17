// Self-test for the UDP wire-auth primitives: HMAC wrap/unwrap roundtrip,
// tamper detection, replay-window behaviour. No hardware required.
//
//   npm run build && node examples/udpauth-selftest.mjs
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import {
    UDP_AUTH_KEY_LEN, UDP_AUTH_OVERHEAD,
    Seq32ReplayWindow, newSessionId, wrapUdp, unwrapUdp,
} from '../dist/frame/UdpAuth.js';

let pass = 0, fail = 0;
const check = (name, cond) => {
    (cond ? pass++ : fail++);
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
};

const key   = randomBytes(UDP_AUTH_KEY_LEN);
const wrong = randomBytes(UDP_AUTH_KEY_LEN);
const sess  = newSessionId();

// roundtrip
const pt   = Buffer.from('hello helionet');
const wire = wrapUdp(key, sess, 0, pt);
check('roundtrip plaintext preserved', unwrapUdp(key, wire).payload.equals(pt));
check('roundtrip session preserved',   unwrapUdp(key, wire).session.equals(sess));
check('roundtrip overhead == UDP_AUTH_OVERHEAD',
    wire.length === pt.length + UDP_AUTH_OVERHEAD);

// zero-length payload (wake-up packet shape)
const empty = wrapUdp(key, sess, 1, Buffer.alloc(0));
check('empty payload roundtrips',   unwrapUdp(key, empty).payload.length === 0);
check('empty payload wire is exactly OVERHEAD', empty.length === UDP_AUTH_OVERHEAD);

// auth failures
try { unwrapUdp(wrong, wire); check('wrong-key rejected', false); }
catch (e) { check('wrong-key rejected', /tag mismatch/.test(e.message)); }

const tampered = Buffer.from(wire);
tampered[12] ^= 0xff;
try { unwrapUdp(key, tampered); check('tampered byte rejected', false); }
catch (e) { check('tampered byte rejected', /tag mismatch/.test(e.message)); }

// replay window
const w = new Seq32ReplayWindow();
check('seq 0 first time',          w.check(sess, 0)   === true);
check('seq 1',                     w.check(sess, 1)   === true);
check('seq 5 (jump)',              w.check(sess, 5)   === true);
check('seq 1 replay rejected',     w.check(sess, 1)   === false);
check('seq 0 replay rejected',     w.check(sess, 0)   === false);
check('seq 4 in-window OK',        w.check(sess, 4)   === true);
check('seq 100 advances window',   w.check(sess, 100) === true);
check('seq 5 now too-old',         w.check(sess, 5)   === false);

// new session id resets the window
const sess2 = newSessionId();
check('seq 0 in new session OK',           w.check(sess2, 0) === true);
check('seq 1 in new session OK',           w.check(sess2, 1) === true);
check('old session usable after re-switch', w.check(sess, 200) === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);