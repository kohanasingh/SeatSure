import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';

// SeatSure booking spike (BUILD_PHASES.md Phase 5): ramp 0→100 over 30s,
// spike to 500 VUs for 1m, ramp down 30s. Every iteration books a random
// seat from the pre-seeded 400-seat pool.
//
// Prep:   pnpm --filter @seatsure/api seed:load   (writes loadtest-data.json)
// Run:    k6 run load/booking-spike.js            (API must be up with
//         RATE_LIMIT_BOOKING_MAX raised — see README "Load test")
// Verify: pnpm --filter @seatsure/api verify:load

const data = JSON.parse(open('./loadtest-data.json'));
const API = __ENV.API_URL || 'http://localhost:3001';

export const options = {
  // status codes are all we assert; skipping body processing keeps k6's CPU
  // footprint from starving the API when both share one machine
  discardResponseBodies: true,
  stages: [
    { duration: '30s', target: 100 },
    { duration: '1m', target: 500 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
};

// 409 SEAT_TAKEN is the *correct* answer once a seat is sold — under
// deliberate contention it is an expected status, not a failure.
http.setResponseCallback(http.expectedStatuses(200, 409));

export default function () {
  const vu = exec.vu.idInTest;
  const token = data.tokens[(vu - 1) % data.tokens.length];
  const seatId = data.seats[Math.floor(Math.random() * data.seats.length)];

  const res = http.post(
    `${API}/trpc/bookings.create`,
    JSON.stringify({ kind: 'assigned', eventId: data.eventId, seatId }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': `k6-${exec.scenario.iterationInTest}-${vu}`,
      },
    },
  );

  check(res, {
    'booked, pending, or seat taken': (r) => r.status === 200 || r.status === 409,
  });
  // jittered human think-time (1.5–3s): constant sleeps synchronize VUs into
  // thundering-herd waves that measure queue drain, not service latency.
  // 500 VUs at ~2.25s mean ≈ 220 rps offered vs ~470 rps measured capacity.
  sleep(1.5 + Math.random() * 1.5);
}
