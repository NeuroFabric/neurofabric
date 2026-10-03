# Demo runbook

**For the person running the demo, not the audience.** Written for the moment
something goes wrong in front of people.

Read the failure playbook *before* you start. The worst outcome in a demo is not a
failure — it is a failure the person on stage did not know how to talk about.

---

## Before you start (10 minutes before)

Three terminals. Everything below is loopback; nothing leaves the machine.

```powershell
# terminal 1 — the wedge on 8080
$env:NEUROFEBRIC_GATEWAY_TOKENS='[{"id":"demo","credential":"<value>","providers":["portal"]}]'
npm run dev
```

```powershell
# terminal 2 — the Command Center on 5173
cd frontend
npm run dev
```

```powershell
# terminal 3 — keep this one ready to paste
cd <repo root>
```

**Check 1 — the wedge is up.** Terminal 1 prints `The wedge is up.` and a URL.

**Check 2 — the UI is up.** Terminal 2 prints `ready in ... ms` and
`http://127.0.0.1:5173/`.

**Check 3 — the UI authenticates.** Open the URL. You should see the agent
selector and the live panel. **If you see the credential prompt, type the value
and press Connect before the demo starts.** An operator who has to find a
credential on stage is an operator who has lost the room.

---

## The demo, in order

### Beat 1 — the empty state (30 seconds)

Show the dashboard with no traffic.

**Say this:** *"This is the honest starting point. No data yet — and it says so,
rather than showing zero."*

That empty state is the product claim: silence is never ambiguous. A panel
reading "0 events/sec" and a panel reading "nothing is arriving" are different
states and the audience should be able to tell them apart before you ever load
data.

### Beat 2 — the flood (the moment)

Paste into terminal 3. **The equals form is the working one on `main`:**

```
node --experimental-strip-types scripts/generate-synthetic-data.ts --flood --url=http://127.0.0.1:8080 --token=<value>
```

Expect roughly:

```
MEASURED (not claimed)
  accepted       20,000
  refused        0
  throughput     ~37,000 events/sec
provider check  pega, 20,000 records visible
```

**Say this while it runs:** *"Watch the record count. It's not a number I typed —
it's measured, and the script prints how long it took."*

**The `provider check` line is the credibility beat.** It reads back what the
server actually holds and compares it to what we pushed to. A demo that asserts
its own success is worth nothing; a demo that checks is worth the whole room.

### Beat 3 — the verdict (the payoff)

Turn to the browser. The live panel now shows a verdict.

**Point at, in this order:**
1. **The breached column.** `elapsed_time`, past its outer fence. Say the number
   in the fence, not the adjective "anomalous".
2. **The top keys.** Which service is producing them. The audience's next
   question is always "which one?", and it should already be on screen.
3. **The alert.** Severity, and that it names the column rather than saying
   "something changed".

**Do not say "AI detected".** There is no model call anywhere in this path. Say
what it actually is: quartiles and fences, computed over the live window, with
the fence stated. If someone asks whether a model is involved, the answer is no,
and that answer is a selling point — it is why the verdict is reproducible.

### Beat 4 — the honesty beat (if you have 30 seconds)

Refresh the page while pointing at throughput.

**Say this:** *"Throughput now reads zero, and the record count still reads
20,000. That is not a bug. Records is a count; throughput is a rate, and a rate is
zero when nothing new arrives in the window. We show it that way rather than
making the rate agree with the count — that would be a measurement agreeing with
a number it was never derived from."*

This is the strongest thirty seconds in the demo. It is the house rule rendering
itself, and it is unrehearsable by a competitor.

---

## Failure playbook

### The UI shows a refusal prompt mid-demo

**What happened:** the client and the wedge disagree about the credential. The
prompt names which of the two problems it is — nothing arrived, or what arrived
was refused.

**Say this:** *"That's our refusal path doing exactly what it's meant to. It
stopped polling instead of retrying — a wrong credential isn't fixed by asking
again, and asking sixty times a minute is how you find out it was never going to
work."*

**Then:** retype the credential in the prompt and press Connect. The poller
resumes at once. This is a **feature demo**, not a rescue — let it happen if it
happens.

### `fetch failed against http://127.0.0.1:8080`

**What happened:** nothing is listening on 8080. The error names the address on
purpose.

**Say this:** *"The target is in the error because 'fetch failed' alone has four
possible causes and you can't pick between them from one word."*

**Then,** in terminal 1 — the wedge is not running, or died. Start it and re-run
the flood. The UI recovers on its own; it does not need a reload.

### The flood reports `accepted 0`

**Do not retry blindly.** Read the `first refusal` line above it:

- `HTTP 401` — wrong credential. Check it against what the wedge was started
  with.
- `fetch failed` — the wedge is not up. See above.
- `PROVIDER MISMATCH` — events were **accepted** and are invisible on the
  dashboard because they went to a provider the live route does not report. Re-run
  with the provider the server names.

### A stale process is holding 8080

**Do not kill it on stage.** Look it up and name it:

```powershell
Get-NetTCPConnection -LocalPort 8080 -State Listen |
  ForEach-Object { Get-Process -Id $_.OwningProcess } |
  Select-Object Id, ProcessName, Path
```

**Say this:** *"There's an older wedge on the port. I'm going to leave it and use
the other port rather than kill something I didn't start."* Then run both on
`WEDGE_PORT=8090` — it costs thirty seconds and it is a better story than killing
a stranger's process on camera.

### Everything is down and you cannot start anything

**Say this:** *"The engine is the thing I can stand behind, and the UI is a thin
client over six HTTP routes. Let me show you the routes directly."*

```powershell
curl.exe -s -H "x-gateway-token: <value>" http://127.0.0.1:8080/api/portal/agents
```

Then `config`, then `live`. The data is still there and still real; you have lost
a renderer, not a system. **Say that out loud** — a demo that degrades to its
substrate is a demo that proved the substrate was the product.

---

## Things to never say

| Do not say | Because |
|---|---|
| "It's an AI agent" | There is no model call. It is quartiles and fences. |
| "Real-time" | It polls every 500ms. Say "live", and say how often. |
| "It's safe because of X" | Say what the control *is*, not that it is sufficient. |
| "Zero errors in the console" | Only if you have looked. Then say the number. |
| Any number you did not just see on screen | This is the one that ends careers. |