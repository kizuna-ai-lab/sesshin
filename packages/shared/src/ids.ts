const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RAND_LEN = 16;

let lastTime = 0;
let lastRand: number[] = [];

function encodeTime(now: number): string {
  let n = now;
  const out: string[] = [];
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out[i] = ALPHABET[n % 32]!;
    n = Math.floor(n / 32);
  }
  return out.join('');
}

function fillRandom(): number[] {
  const out: number[] = new Array(RAND_LEN);
  for (let i = 0; i < RAND_LEN; i++) out[i] = Math.floor(Math.random() * 32);
  return out;
}

function bumpRandom(r: number[]): number[] {
  const out = r.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]! < 31) { out[i]!++; return out; }
    out[i] = 0;
  }
  return fillRandom(); // overflow — fall back to fresh
}

export function ulid(): string {
  const now = Date.now();
  const rand = (now === lastTime) ? bumpRandom(lastRand) : fillRandom();
  lastTime = now;
  lastRand = rand;
  return encodeTime(now) + rand.map((n) => ALPHABET[n]).join('');
}
