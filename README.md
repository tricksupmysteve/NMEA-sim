# Matey NMEA Simulator

A realistic marine instrument simulator that generates live **NMEA 0183** data and
exposes it as a continuous **raw TCP stream** — the same thing an NMEA-over-Wi-Fi
gateway on a boat presents to a phone or a chart plotter.

The same repository runs two ways:

```
LOCAL MODE
  Your Mac acts like the NMEA Wi-Fi gateway.
  Your phone connects to the Mac's LAN IP, e.g. 192.168.1.25:39150

RAILWAY MODE
  Railway acts like a remote NMEA TCP gateway.
  Your phone connects to the Railway hostname and assigned TCP port,
  e.g. something.proxy.rlwy.net:12345
```

Railway is not pretending to be physically present on your local Wi-Fi network.
It is a second, internet-reachable endpoint serving the identical stream from the
identical simulator engine and encoder.

---

## Contents

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Architecture](#architecture)
- [NMEA sentences produced](#nmea-sentences-produced)
- [Physics](#physics)
- [Scenarios](#scenarios)
- [Testing source and freshness handling](#testing-source-and-freshness-handling)
- [Local installation](#local-installation)
- [macOS Wi-Fi / LAN testing](#macos-wi-fi--lan-testing)
- [Connecting a phone](#connecting-a-phone)
- [Docker](#docker)
- [Railway deployment](#railway-deployment)
- [HTTP control API](#http-control-api)
- [Configuration](#configuration)
- [CLI](#cli)
- [Testing](#testing)
- [Manual verification](#manual-verification)
- [Troubleshooting](#troubleshooting)
- [Scope and limitations](#scope-and-limitations)

---

## What it does

The simulator maintains **one canonical boat**: a vessel with a position, a
heading, a speed through the water, in an environment with a true wind, a
current, a seabed and a sea state. Every number it transmits is derived from
that single state.

That is the point. It does not generate an unrelated random number per field.
When a gust arrives, the apparent wind rises, the boat heels, it makes more
leeway, and its course over ground moves away from its heading — all from the
same underlying change, exactly as they would on the water. When the boat tacks,
the apparent wind swaps sides.

It exists to be a **reusable development tool** for building and testing NMEA
consumers such as Matey:

- a continuous, valid NMEA 0183 stream over TCP, with correct checksums;
- instruments updating at genuinely different rates, so data-age and staleness
  handling can be tested for real;
- deterministic, seeded scenarios that replay identically;
- controlled, repeatable sensor failures — dropouts, frozen values, invalid
  fixes, bad checksums, malformed sentences;
- an HTTP API to drive all of it from a test.

**Zero runtime dependencies.** Node's own `net` and `http` modules do the work.

---

## Quick start

```bash
git clone <this-repo>
cd matey-nmea-simulator

npm install
npm run dev
```

```
Matey NMEA Simulator
────────────────────────────────────────────────────

Scenario      sailing — Sailing
Profile       garmin-wifi (9 sentences)
Seed          12345
NMEA TCP      0.0.0.0:39150
HTTP          0.0.0.0:3000

Local connections:
  192.168.1.25:39150   (en0)

Point Matey (or any NMEA client) at:  192.168.1.25:39150
Verify from a terminal with:          nc 192.168.1.25 39150

Sentences: RMC GGA VTG HDT VHW MWV MWD DPT MTW
```

From another terminal:

```bash
nc 127.0.0.1 39150
```

```
$GPRMC,174841.29,A,4156.9968,N,07017.9966,W,6.2,145.0,190826,14.5,W,A*08
$GPGGA,174841.29,4156.9968,N,07017.9966,W,1,10,0.7,2.0,M,34.2,M,,*72
$GPVTG,145.0,T,159.5,M,6.2,N,11.5,K,A*1A
$IIHDT,144.8,T*2B
$IIVHW,144.8,T,159.3,M,5.77,N,10.69,K*69
$WIMWV,69.9,R,15.0,N,A*21
$WIMWD,238.9,T,253.4,M,14.1,N,7.3,M*6A
$SDDPT,11.8,0.6,*45
$WIMTW,16.5,C*0F
```

---

## Architecture

```
                       ┌──────────────────────────────┐
                       │        Scenario              │
                       │  sailing / storm / anchored   │
                       │  · initial world              │
                       │  · per-tick behaviour         │
                       │  · fault timeline             │
                       └──────────────┬───────────────┘
                                      │
        ┌─────────────────────────────▼─────────────────────────────┐
        │                          World                             │
        │   Environment  ──►  Boat  ──►  canonical BoatState         │
        │   true wind          heading, STW, position                │
        │   current            heel, pitch, leeway                   │
        │   seabed, sea state  COG/SOG, apparent wind                │
        └─────────────────────────────┬─────────────────────────────┘
                                      │  each instrument samples at its own rate
        ┌─────────────────────────────▼─────────────────────────────┐
        │                   Instrument channels                      │
        │   gps  heading  wind  depth  waterSpeed  temperature  …    │
        │   value · lastUpdatedAt · enabled · fault                  │
        └─────────────────────────────┬─────────────────────────────┘
                                      │  each sentence encodes at its own rate
        ┌─────────────────────────────▼─────────────────────────────┐
        │                    NMEA 0183 encoder                       │
        │   validate body → add $ / ! → XOR checksum → CRLF          │
        └─────────────────────────────┬─────────────────────────────┘
                                      │
                       ┌──────────────▼──────────────┐
                       │         Transports           │
                       │   TCP (:39150)   UDP (opt.)  │
                       └──────────────┬──────────────┘
                                      │
                                   Matey
```

```
src/
├── index.ts               entry point, CLI, graceful shutdown
├── config.ts              env + .env + CLI, validated up front
├── engine.ts              wires clock, world, encoder and transports together
├── types.ts               the canonical BoatState
│
├── core/
│   ├── math.ts            angles, vectors, smoothing
│   ├── units.ts           knots / m/s / feet / fathoms / hPa …
│   ├── random.ts          seeded PRNG, Ornstein–Uhlenbeck, gusts, value noise
│   ├── logger.ts          levelled logging
│   └── net.ts             LAN address discovery
│
├── simulator/
│   ├── clock.ts           simulation clock, scheduler, real-time/manual drivers
│   ├── physics.ts         apparent wind, ground track, position, heel, leeway
│   ├── environment.ts     true wind, current, seabed, sea state, temperature
│   ├── boat.ts            the vessel: steering, speed, attitude, anchoring
│   ├── instruments.ts     instrument channels, freshness, GNSS model
│   ├── faults.ts          deterministic fault timelines
│   ├── traffic.ts         optional AIS targets
│   └── world.ts           one world, one canonical state
│
├── nmea0183/
│   ├── checksum.ts        XOR checksum, sentence framing, parsing
│   ├── format.ts          latitude/longitude/UTC/number field formatters
│   ├── encoder.ts         validation and framing for every sentence
│   ├── registry.ts        the sentence catalogue
│   ├── profiles.ts        garmin-wifi and the other output profiles
│   ├── sentences/         one module per sentence formatter
│   └── ais/               six-bit armouring and AIS message construction
│
├── transports/
│   ├── transport.ts       the transport interface
│   ├── tcp.ts             raw NMEA over TCP — the primary transport
│   └── udp.ts             optional UDP output
│
├── scenarios/             sailing, cruising, anchored, storm, sensor-failure
├── api/                   HTTP control API and request validation
└── ui/                    startup banner and console dashboard
```

### Why it is layered this way

The encoder is a pure function of the instrument snapshots. The instruments are a
sampled view of the canonical `BoatState`. The transports know nothing about
NMEA beyond "here is a string, send it".

That means a second protocol — NMEA 2000, Signal K, a WebSocket — plugs in
against the same `BoatState` without touching the simulation. The sentence
definitions already carry the NMEA 2000 PGN each one corresponds to:

| Concept | PGN | NMEA 0183 |
|---|---|---|
| Vessel heading | 127250 | HDT, HDM, HDG |
| Rate of turn | 127251 | ROT |
| Attitude | 127257 | XDR |
| Water-referenced speed | 128259 | VHW |
| Water depth | 128267 | DPT, DBT |
| Position, rapid update | 129025 | GLL |
| COG and SOG, rapid update | 129026 | VTG |
| GNSS position data | 129029 | GGA, RMC |
| Wind data | 130306 | MWV, MWD |
| Humidity | 130313 | MDA |
| Actual pressure | 130314 | MDA, XDR |
| Temperature | 130316 | MTW, MDA |

`GET /sentences` reports this mapping at runtime.

---

## NMEA sentences produced

Every sentence, without exception:

- begins with `$` (or `!` for encapsulated AIS sentences);
- carries a freshly computed XOR checksum — never a hard-coded one;
- ends with `\r\n`;
- uses valid `ddmm.mmmm` / `dddmm.mmmm` coordinates and `hhmmss.ss` / `ddmmyy`
  times;
- never contains `NaN`, `undefined`, `Infinity` or a malformed decimal.

The last point is enforced structurally: a sentence body that fails validation is
dropped and counted, not transmitted. The only exception is deliberate fault
injection, which is applied *after* validation so a consumer can be tested
against broken input on purpose.

### Default profile: `garmin-wifi`

The prioritised first-version set, at the default rates:

| Sentence | Talker | Rate | Carries |
|---|---|---|---|
| `RMC` | `GP` | 1 Hz | UTC, status, position, SOG, COG, date, variation |
| `GGA` | `GP` | 1 Hz | UTC, position, fix quality, satellites, HDOP, altitude |
| `VTG` | `GP` | 1 Hz | COG true and magnetic, SOG in knots and km/h |
| `HDT` | `II` | 5 Hz | True heading |
| `VHW` | `II` | 2 Hz | Heading and **speed through the water** |
| `MWV` | `WI` | 5 Hz | **Apparent** wind angle and speed, validity |
| `MWD` | `WI` | 1 Hz | **True wind direction** (compass) and speed |
| `DPT` | `SD` | 1 Hz | Depth below transducer, transducer offset |
| `MTW` | `WI` | 0.2 Hz | Water temperature |

### Other profiles

| Profile | Adds |
|---|---|
| `garmin-wifi` | the nine above |
| `garmin-wifi-full` | `HDG` `HDM` `DBT` `GSA` `GSV` `XDR` and true-referenced `MWV` |
| `minimal` | `RMC` `GGA` `VTG` `HDT` only |
| `full` | everything: `GLL` `ZDA` `ROT` `VLW` `MDA` and AIS `VDO`/`VDM` |

`npm run sim -- --list-sentences` prints the whole catalogue.

### The three wind measurements are three different things

This is the distinction the simulator is most careful about, because it is the
one most often collapsed:

```
MWV ... R    apparent wind angle off the bow + apparent wind speed
             — what the masthead unit physically feels

MWV ... T    true wind angle off the bow + true wind speed
             — the true wind, still expressed relative to the vessel

MWD          true wind direction as a compass bearing + true wind speed
             — independent of where the bow happens to point
```

With the boat heading 145° and a 14 kn true wind from 240°, moving at 6.1 kn:

```
$WIMWV,67.8,R,15.1,N,A     apparent: 67.8° off the bow at 15.1 kn
$WIMWV,95.0,T,14.0,N,A     true relative: 95.0° off the bow at 14.0 kn
$WIMWD,240.0,T,254.5,M,14.0,N,7.2,M    true direction: from 240° at 14.0 kn
```

None of these is a relabelling of another. Only the true wind and the vessel's
velocity are simulated; the apparent wind is computed from them.

### AIS

Optional, off by default (`ENABLE_AIS=true` to turn on), and nothing else depends
on it. When enabled, the simulator emits `!AIVDO` for own ship and `!AIVDM` for
a few simulated targets, as type 1 position reports with proper six-bit payload
armouring.

---

## Physics

### Apparent wind

The apparent wind is derived from the true wind vector and the vessel's velocity
vector, in one place:

```
apparent-wind-from vector  =  TWS · unit(TWD)  +  SOG · unit(COG)

AWS = |apparent-wind-from vector|
AWA = direction(apparent-wind-from vector) − heading
```

Sail straight into a 10 kn wind at 5 kn and AWS is 15 kn dead ahead. Run away
from it at 4 kn and AWS is 6 kn dead astern. Put it on the beam and AWS is
`√(TWS² + BS²)`, drawn forward. Tack, and the apparent wind crosses the bow. All
of that falls out of the vector sum; none of it is special-cased.

### Speed over ground versus speed through the water

```
heading + leeway  ──►  velocity through the water   (VHW)
       + current  ──►  velocity over the ground     (VTG, RMC)
```

The difference between SOG and STW is the current, and the difference between
COG and heading is the current plus leeway. A consumer that conflates the two
will visibly disagree with the simulator.

At anchor this is at its most instructive: SOG is essentially zero while STW
reads the current flowing past the hull.

### Everything else moves smoothly

- Wind speed is a slowly drifting base plus discrete **gust envelopes** that
  build quickly and fade more slowly — never a fresh random number per tick.
- Heading, boat speed, depth, temperature, pressure and current all use
  mean-reverting **Ornstein–Uhlenbeck** processes, so successive samples are
  correlated and nothing jumps.
- Water temperature reverts on a 40-minute time constant; it barely moves.
- The seabed is a smooth function *of position*, so sailing back over the same
  ground reproduces the same contour. Tide and sensor noise ride on top.
- Sea state builds from the wind (fetch-limited), and drives pitch, roll and the
  short-term noise in the depth reading.
- Heel comes from the apparent wind's heeling moment, damped, with the wave-
  induced roll on top; leeway follows from heel and boat speed.

### Determinism

```bash
SIM_SEED=12345
```

Every stochastic process draws from a *named substream* derived from the master
seed, so adding a new noise source later does not shift the numbers consumed by
the existing ones. The same seed and scenario reproduce substantially the same
data sequence — and under the test harness, which uses a virtual clock, the
sentence stream is byte-for-byte identical.

---

## Scenarios

```bash
npm run sim -- --scenario sailing
npm run sim -- --scenario cruising
npm run sim -- --scenario anchored
npm run sim -- --scenario storm
npm run sim -- --scenario sensor-failure
```

or at runtime: `POST /scenario/:name`.

### `sailing` (default)

Coastal sailing on a reach. Starting conditions:

```
SOG          6.1 kn
STW          5.8 kn        (the difference is a fair current)
heading      145°
true wind    14 kn from 240°
depth        12 m
```

Natural heading wander, gusts, gradual speed changes, heel that responds to the
wind, leeway, and periodic tacks and gybes that swap the apparent wind across
the bow.

### `cruising`

Motoring at 18–25 kn, heading around 090°, gentle course changes every couple of
minutes, minimal heel, no leeway, deeper water.

### `anchored`

```
SOG          ~0 kn, with metre-scale GPS drift
heading      swings through 60–70° as the boat sails about its anchor
STW          reads the current flowing past the hull
wind         still active
depth        stable, moving only with the tide
```

### `storm`

38 kn mean true wind gusting into the 50s, a heavy sea, large heading and speed
variation, heavy motion, a falling barometer. Severe but survivable — the values
stay inside what a real vessel and real instruments would report, because the
point is to stress a consumer with *plausible* extremes.

### `sensor-failure`

The critical one, and the most strictly deterministic. A vessel under way while
instruments fail on a fixed schedule:

| t | What happens | What a consumer sees |
|---|---|---|
| 0:20 | wind stops updating | `MWV`/`MWD` keep arriving with an unchanging, ageing value |
| 0:35 | wind returns | values move again |
| 0:50 | GPS disappears | `RMC`, `GGA` and `VTG` stop entirely |
| 1:10 | GPS returns | position sentences resume |
| 1:25 | heading freezes | `HDT` keeps arriving, always the same number |
| 1:45 | heading returns | |
| 2:00 | depth goes stale | `DPT` frozen |
| 2:20 | depth returns | |
| 2:35 | five bad checksums | exactly five sentences fail checksum validation |
| 2:45 | one malformed sentence | one truncated sentence with no checksum at all |
| 2:55 | GPS reports an invalid fix | `RMC` status `V`, `GGA` fix quality `0`, empty position |
| 3:15 | everything recovers | |
| 3:40 | the timeline repeats | |

Note that a *bad checksum* and a *malformed sentence* are deliberately different
failure modes: the first still parses and should be rejected by checksum
validation; the second does not parse at all.

---

## Testing source and freshness handling

Instruments sample **independently of** the sentences that carry them, so a
consumer sees genuinely different data ages per source:

```bash
curl -s localhost:3000/state | jq '.instruments'
```

```
gps            4 Hz   received 51 ms ago
heading       10 Hz   received 51 ms ago
wind           5 Hz   received 51 ms ago
depth          2 Hz   received 51 ms ago
waterSpeed     4 Hz   received 51 ms ago
temperature  0.5 Hz   received 1051 ms ago
pressure     0.2 Hz   received 2051 ms ago
```

Both sensor sampling rates (`SENSOR_INTERVAL_*_MS`) and sentence transmission
rates (`NMEA_RATE_*`) are configurable, statically and at runtime.

Instruments can be switched off entirely:

```bash
ENABLE_GPS=false ENABLE_WIND=true npm run dev
npm run sim -- --disable wind,depth
curl -X POST localhost:3000/instruments/depth -H 'content-type: application/json' -d '{"enabled":false}'
```

…or faulted without being removed:

```bash
# still transmitting, but the value never changes
curl -X POST localhost:3000/instruments/wind -d '{"fault":"frozen"}' -H 'content-type: application/json'
# transmitting nothing at all
curl -X POST localhost:3000/instruments/gps  -d '{"fault":"offline"}' -H 'content-type: application/json'
# transmitting, but flagged invalid
curl -X POST localhost:3000/instruments/gps  -d '{"fault":"invalid"}' -H 'content-type: application/json'
# back to normal
curl -X POST localhost:3000/instruments/gps  -d '{"fault":"none"}' -H 'content-type: application/json'
```

…and the wire itself can be damaged on demand:

```bash
curl -X POST localhost:3000/faults -H 'content-type: application/json' -d '{"type":"badChecksum","count":5}'
curl -X POST localhost:3000/faults -H 'content-type: application/json' -d '{"type":"malformed","count":1}'
curl -X POST localhost:3000/faults -H 'content-type: application/json' -d '{"type":"badChecksum","probability":0.02,"durationSeconds":60}'
curl -X POST localhost:3000/faults -H 'content-type: application/json' -d '{"type":"clearAll"}'
```

### How a consumer might normalise the output

The simulator does not impose any consumer's schema. It emits realistic protocol
data; a consumer attaches its own metadata after reception:

| Sentence | Metric |
|---|---|
| `RMC` / `GGA` | position |
| `VTG` | COG / SOG |
| `HDT` | true heading |
| `VHW` | speed through the water |
| `MWV` (R) | apparent wind speed / angle |
| `MWD` | true wind direction / speed |
| `DPT` | water depth |
| `MTW` | water temperature |

```json
{
  "metric": "wind.apparent.speed",
  "value": 14.7,
  "unit": "kn",
  "source": { "protocol": "nmea0183", "sentence": "MWV", "connection": "tcp" },
  "receivedAt": "2026-03-14T09:26:53.500Z",
  "provenance": "measured"
}
```

---

## Local installation

Requires **Node.js 20.11 or newer** (22 recommended).

```bash
git clone <this-repo>
cd matey-nmea-simulator

npm install
npm run dev
```

Optionally copy the example configuration and edit it:

```bash
cp .env.example .env
```

`.env` is read at startup; real environment variables always win over it.

---

## macOS Wi-Fi / LAN testing

The simulator binds to `0.0.0.0` by default, **not** `127.0.0.1`, because a phone
on the same Wi-Fi network cannot reach a loopback-only socket.

### Finding your Mac's LAN IP

The banner prints every usable address at startup. If you need it separately:

```bash
ipconfig getifaddr en0     # Wi-Fi on most Macs
ipconfig getifaddr en1     # Wi-Fi on some models, or a second interface
```

or, to see everything:

```bash
ifconfig | grep "inet " | grep -v 127.0.0.1
```

The address will normally look like `192.168.1.25`, `10.0.0.42` or
`172.20.10.3`.

### macOS firewall

The first time you run it, macOS may ask whether to allow incoming connections
for `node` (or `Docker`, if you are running the container). **Allow it** — if you
dismiss the prompt, connections from other devices are silently refused while
`nc 127.0.0.1 39150` on the Mac itself keeps working, which is a confusing
combination.

To check or change it afterwards:

**System Settings → Network → Firewall → Options** — make sure `node` (or
`Docker Desktop`) is set to *Allow incoming connections*, and that
*Block all incoming connections* is off.

The Mac and the phone must be on the **same Wi-Fi network**, and that network
must not have client isolation (also called "AP isolation" or "guest mode")
enabled — many guest and hotel networks do, and it blocks device-to-device
traffic entirely.

---

## Connecting a phone

1. Put the phone on the same Wi-Fi network as the Mac.
2. Read the LAN address from the simulator's startup banner.
3. In Matey (or any NMEA client), add a **TCP** connection:

```
Host:  192.168.1.25       ← your Mac's LAN IP
Port:  39150
```

That is it. The client does not need to send anything: data starts flowing the
moment the socket opens.

To sanity-check from the phone without an app, any TCP terminal app will do — or
test from a second computer first:

```bash
nc 192.168.1.25 39150
```

---

## Docker

```bash
docker build -t matey-nmea-simulator .

docker run --rm \
  -p 39150:39150 \
  -p 3000:3000 \
  matey-nmea-simulator
```

With options:

```bash
docker run --rm \
  -p 39150:39150 -p 3000:3000 \
  -e SIM_SCENARIO=storm \
  -e SIM_SEED=42 \
  -e LOG_NMEA=true \
  matey-nmea-simulator
```

The image is a two-stage build on `node:22-alpine`: the first stage compiles the
TypeScript, the second carries only `dist/` and a production dependency tree
(which is empty — there are no runtime dependencies). It runs as the unprivileged
`node` user and declares a `HEALTHCHECK` against `/health`.

Node runs as PID 1 and installs its own `SIGTERM`/`SIGINT` handlers, so
`docker stop` shuts the simulator down cleanly rather than waiting for the kill
timeout.

---

## Railway deployment

The **same repository** deploys to Railway with no changes. The NMEA service
listens internally on `0.0.0.0:39150`; Railway's TCP Proxy publishes it.

### 1. Deploy the repository

Create a new Railway project from this repository. `railway.json` selects the
Dockerfile builder and points the health check at `/health`.

### 2. Add a TCP Proxy

1. Open the Railway **service settings**.
2. Open **Networking**.
3. Add a **TCP Proxy**.
4. Set the internal port to:

```
39150
```

5. Railway generates a public endpoint of the form:

```
something.proxy.rlwy.net:12345
```

### 3. Point Matey at the Railway endpoint

Use the hostname and the **external port Railway assigned**:

```
Host:  something.proxy.rlwy.net
Port:  12345
```

> **The public port will not be 39150.** Railway assigns an arbitrary external
> port and maps it to your internal `39150`. Do not assume a static public IP
> either — always use the hostname Railway gives you, and re-check it after
> recreating the proxy.

### 4. Verify

```bash
nc <RAILWAY_TCP_HOST> <RAILWAY_TCP_PORT>
```

The same continuous NMEA stream should appear.

### The HTTP API on Railway

Railway injects `PORT` for the HTTP service; the simulator uses it automatically.
The control API is then reachable at your service's normal Railway domain:

```bash
curl https://<your-service>.up.railway.app/health
```

Because that is a public URL, consider setting `API_TOKEN` so everything except
`/health` requires `Authorization: Bearer <token>`. `/health` stays open so
Railway's health check keeps working.

### Running without Railway

Nothing in the simulator depends on Railway. It runs identically from `npm run
dev`, from `docker run`, or on any host that can open a TCP port.

---

## HTTP control API

Separate from the NMEA stream, and entirely optional (`HTTP_ENABLED=false`
disables it). Every response is JSON.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | route index |
| `GET` | `/health` | liveness and a one-line summary |
| `GET` | `/state` | canonical boat state, instrument freshness, sentence ages |
| `GET` | `/config` | effective configuration (never the API token) |
| `GET` | `/scenarios` | available scenarios |
| `GET` | `/instruments` | instrument enable/fault state and data age |
| `GET` | `/sentences` | sentence catalogue, rates, talkers, PGN mappings |
| `GET` | `/clients` | connected TCP clients |
| `GET` | `/metrics` | counters |
| `GET` | `/faults` | active faults and fault history |
| `POST` | `/scenario/:name` | switch scenario |
| `PATCH` | `/state` | override simulated values |
| `POST` | `/instruments/:id` | enable/disable or fault an instrument |
| `POST` | `/faults` | inject a fault |
| `POST` | `/sentences/:id/rate` | change a sentence's transmission rate |

```bash
curl localhost:3000/health
curl localhost:3000/state
curl localhost:3000/scenarios

curl -X POST localhost:3000/scenario/sailing
curl -X POST localhost:3000/scenario/cruising
curl -X POST localhost:3000/scenario/anchored
curl -X POST localhost:3000/scenario/storm
curl -X POST localhost:3000/scenario/sensor-failure

curl -X PATCH localhost:3000/state \
  -H 'content-type: application/json' \
  -d '{"wind":{"trueSpeedKnots":18,"trueDirectionDegrees":240}}'

curl -X POST localhost:3000/sentences/HDT/rate \
  -H 'content-type: application/json' -d '{"hz":10}'
```

`PATCH /state` accepts partial updates to `position`, `navigation`, `wind`,
`environment`, `motion` and `current`. Everything is validated: unknown fields,
non-finite numbers and out-of-range values are all rejected with a list of what
was wrong.

```json
{
  "error": "Invalid state patch",
  "problems": ["wind.trueSpeedKnots must be between 0 and 150"]
}
```

Setting the true wind through `PATCH /state` changes the true wind only — the
apparent wind continues to be derived from it.

---

## Configuration

All configuration is validated at startup; a bad value produces a clear list of
problems rather than a `NaN` in a sentence half an hour later.

Precedence, lowest to highest: **defaults → `.env` → environment → CLI flags**.

```env
NODE_ENV=development

NMEA_HOST=0.0.0.0
NMEA_PORT=39150

PORT=3000

SIM_SCENARIO=sailing
SIM_SEED=12345

ENABLE_GPS=true
ENABLE_HEADING=true
ENABLE_WIND=true
ENABLE_DEPTH=true
ENABLE_WATER_SPEED=true
ENABLE_TEMPERATURE=true

LOG_NMEA=false
```

The full annotated list is in [`.env.example`](.env.example). The most useful
extras:

| Variable | Default | Purpose |
|---|---|---|
| `NMEA_PROFILE` | `garmin-wifi` | output profile |
| `NMEA_RATE_<ID>` | from profile | per-sentence rate in Hz; `0` stops it |
| `SENSOR_INTERVAL_<ID>_MS` | see `.env.example` | per-instrument sampling interval |
| `SIM_TIME_SCALE` | `1` | speed up or slow down simulated time |
| `SIM_START_TIME` | process start | pin the simulated UTC start instant |
| `MAGNETIC_VARIATION_DEG` | `-14.5` | positive is east |
| `API_TOKEN` | unset | require a bearer token on the control API |
| `ENABLE_AIS` | `false` | emit `!AIVDO` / `!AIVDM` |
| `UDP_ENABLED` | `false` | also broadcast over UDP |
| `NMEA_MAX_CLIENTS` | `64` | simultaneous TCP clients |
| `LOG_LEVEL` | `info` | `silent` / `error` / `warn` / `info` / `debug` |
| `STATUS_INTERVAL_MS` | `5000` | console dashboard refresh; `0` disables |

---

## CLI

```bash
npm run dev                                  # start with defaults
npm run sim -- --scenario sailing
npm run sim -- --scenario anchored
npm run sim -- --scenario storm
npm run sim -- --scenario sensor-failure

npm run sim -- --port 39150 --seed 12345 --scenario sailing
npm run sim -- --verbose                     # print every sentence
npm run sim -- --disable wind,depth          # simulate missing instruments
npm run sim -- --list-scenarios
npm run sim -- --list-sentences
npm run sim -- --help
```

| Flag | Purpose |
|---|---|
| `-s, --scenario <name>` | scenario to run |
| `--profile <name>` | output profile |
| `-p, --port <port>` | NMEA TCP port |
| `--host <address>` | NMEA TCP bind address |
| `--http-port <port>` | HTTP control API port |
| `--no-http` | do not start the control API |
| `--seed <number>` | seed for repeatable runs |
| `--time-scale <n>` | speed up or slow down simulated time |
| `--enable / --disable <list>` | comma-separated instrument names |
| `--udp` | also broadcast over UDP |
| `-v, --verbose` | print every sentence as it is transmitted |
| `--quiet` | suppress the banner and dashboard |

### Console output

On a TTY the dashboard refreshes in place every few seconds:

```
Matey NMEA Simulator
────────────────────────────────────────

Scenario       sailing
TCP            0.0.0.0:39150
HTTP           0.0.0.0:3000

LAN:
192.168.1.25:39150

Clients        1
Sentences      1324 sent

Boat
SOG            6.2 kn
STW            5.8 kn
COG            148°
Heading        145°
Depth          12.1 m

Wind
AWS            17.1 kn
AWA            38°
TWS            14.0 kn
TWD            240°
```

In a non-interactive log (Docker, Railway) the same information is printed as one
greppable line per interval, so the log stays readable.

`--verbose` additionally prints every raw sentence.

---

## Testing

```bash
npm test          # the full suite
npm run typecheck # strict TypeScript, no emit
npm run check     # both
npm run build     # compile to dist/
```

364 tests, no test dependencies beyond Node's own runner, and no wall-clock
flakiness: the engine accepts an injected clock, so scenario tests advance
virtual time and replay exactly.

Coverage includes:

- checksum calculation (against an independent reference implementation)
- CRLF termination and sentence framing
- latitude and longitude formatting, including the rounding carry and the poles
- UTC time and date formatting
- generation of `RMC`, `GGA`, `VTG`, `HDT`, `HDG`, `HDM`, `VHW`, `MWV`, `MWD`,
  `DPT`, `DBT`, `MTW`, `GLL`, `ZDA`, `GSA`, `GSV`, `ROT`, `VLW`, `XDR`, `MDA`
  and the AIS sentences, field by field
- the guarantee that no sentence can contain `NaN`, `undefined` or `Infinity`
- physics: apparent wind (including a round trip back to the true wind), ground
  track, position integration, heel, leeway, rate of turn, the sailing polar
- wind vector calculations from every quarter
- seeded determinism: identical streams from identical seeds, across all five
  scenarios and across scenario switches
- scenario plausibility: every value finite and in range over long runs
- the sensor-failure timeline, event by event
- TCP: connection, streaming without a request, multiple simultaneous clients,
  disconnect, reconnect, backpressure on a stalled client, connection limits,
  graceful shutdown, port reuse
- the control API: every route, plus validation of every input
- end to end: a real socket receiving real sentences from the real engine

The end-to-end test opens a TCP socket to the running simulator and asserts that
valid NMEA sentences arrive, that every required sentence type appears, and that
every checksum is correct.

---

## Manual verification

### Local

```bash
npm run dev
```

From another terminal:

```bash
nc 127.0.0.1 39150
```

Expected:

```
$GPRMC,...
$GPGGA,...
$GPVTG,...
$IIHDT,...
$WIMWV,...
$WIMWD,...
$IIVHW,...
$SDDPT,...
$WIMTW,...
```

with valid checksums throughout.

Check the rates by counting sentences over ten seconds:

```bash
timeout 10 nc 127.0.0.1 39150 | cut -c1-6 | sort | uniq -c | sort -rn
```

```
  50 $IIHDT     5 Hz
  50 $WIMWV     5 Hz
  20 $IIVHW     2 Hz
  10 $GPRMC     1 Hz
  10 $GPGGA     1 Hz
  10 $GPVTG     1 Hz
  10 $WIMWD     1 Hz
  10 $SDDPT     1 Hz
   2 $WIMTW     0.2 Hz
```

Verify every checksum independently:

```bash
timeout 10 nc 127.0.0.1 39150 | python3 -c "
import sys
ok = bad = 0
for line in sys.stdin:
    text = line.strip()
    body, _, cks = text[1:].partition('*')
    c = 0
    for ch in body: c ^= ord(ch)
    ok, bad = (ok + 1, bad) if f'{c:02X}' == cks.upper() else (ok, bad + 1)
print('valid:', ok, ' invalid:', bad)
"
```

Then from another device on the same Wi-Fi:

```bash
nc <MAC_LAN_IP> 39150
```

for example:

```bash
nc 192.168.1.25 39150
```

### Railway

After enabling the TCP Proxy:

```bash
nc <RAILWAY_TCP_HOST> <RAILWAY_TCP_PORT>
```

for example:

```bash
nc something.proxy.rlwy.net 12345
```

The same continuous NMEA stream should appear.

---

## Troubleshooting

**The phone cannot connect, but `nc 127.0.0.1 39150` works on the Mac.**
Almost always the macOS firewall or the wrong IP. Check the address in the
startup banner (or `ipconfig getifaddr en0`), and allow incoming connections for
`node` under System Settings → Network → Firewall → Options.

**`Connection refused` from another device.**
Either the simulator is bound to loopback (`NMEA_HOST=127.0.0.1` — the banner
warns about this) or the two devices are not on the same network. Guest and
hotel Wi-Fi networks frequently block device-to-device traffic entirely.

**`EADDRINUSE` at startup.**
Something is already on 39150 — most likely a previous run that did not exit.
`lsof -i :39150` will name it; or start on another port with `--port 39151`.

**Nothing arrives after connecting.**
The stream starts immediately, so silence means the client is waiting to send
something first. It should not: the simulator never expects input. Check with
`nc`, which sends nothing.

**Railway: `nc` to the proxy hostname hangs or is refused.**
Check that the TCP Proxy's internal port is `39150`, and that you are using the
**external** port Railway assigned — not 39150. Confirm the service is up with
`curl https://<service>.up.railway.app/health`.

**Railway: the deployment is marked unhealthy.**
The health check hits `/health` on the HTTP service. Make sure `HTTP_ENABLED` is
not set to `false`, and that you have not overridden `PORT`.

**Sentences stop for one instrument.**
Either that instrument is disabled (`GET /instruments` shows `enabled: false`),
or the sensor-failure scenario is running and has taken it offline
(`GET /faults` shows the history).

**Values look frozen.**
Check `GET /instruments` for a `frozen` fault, or `ageMs` climbing. If the
scenario is `sensor-failure`, that is the scenario working as designed.

**The console dashboard is scrolling instead of refreshing in place.**
That is expected when output is not a TTY, or when `--verbose` is on (raw
sentences and an in-place dashboard would fight over the cursor).

**A client stops receiving some sentences.**
A client that does not drain its socket is deliberately shed rather than
buffered without limit; `GET /clients` reports a `dropped` count per client. Read
faster, or raise `NMEA_CLIENT_HIGH_WATER_BYTES`.

---

## Scope and limitations

- **This is a standards-based NMEA 0183 simulator with a Garmin-*like* Wi-Fi TCP
  profile.** It does not implement, emulate or reverse engineer the Garmin Marine
  Network, BlueNet, or any other proprietary Garmin protocol, and it makes no
  claim about the transmission rates any particular Garmin product uses. The
  `garmin-wifi` profile is a sentence set and a set of simulator defaults.
- Magnetic variation is a configured constant, not a world magnetic model. Set
  `MAGNETIC_VARIATION_DEG` for the area you are simulating.
- The sailing polar is a plausible curve, not a measured polar for any real hull.
  Heel and leeway are bounded approximations, not naval architecture.
- The seabed is procedurally generated, not real bathymetry. Positions are real
  coordinates but the depths under them are invented.
- A fully populated `MDA` sentence exceeds the 82-character limit the standard
  specifies. Real weather instruments emit it over-length too, so the sentence
  opts out of the cap explicitly; every other sentence stays inside it.
- AIS support covers type 1 position reports only, and is off by default.
- NMEA 2000 output is not implemented. The architecture and the PGN mappings are
  in place for it to be added against the same `BoatState`.

---

## License

MIT — see [LICENSE](LICENSE).
