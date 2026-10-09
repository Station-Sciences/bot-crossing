# Bot social life — idle bots chat, argue, comfort each other and play

**Status:** approved (approach A, social director). **Date:** 2026-10-09.
**Builds on:** war mode's order layer (`src/agents/war-orders.js`, `astronauts.setWarOrders`).

## What this is

Idle bots have a social life. Two drift together and chat; a few gather in a ring; two bicker
and stomp off; one is heartbroken and another walks over to comfort it; a handful kick a ball
about or play chase. Some of it is ambient — the colony feeling alive — and some of it means
something: it is set off by real events in your threads.

## Rules that cannot bend

- **Only `idle` bots take part.** Never `sleeping` (that means three days quiet, and waking it
  would misrepresent it), never `working`, `waiting`, `blocked` or `celebrating`. The moment any
  participant's status changes, its part ends that frame and it goes straight back to its job;
  a scene that loses a participant it cannot do without ends.
- **War outranks social.** A bot under war orders is never in a scene, and a battle starting
  ends any scene its fighters were in.
- **Emotions never look like status.** No status badge (`? ! ⚒ ✓ z`), no red eyes, no `error`
  face for any social emotion. Anger gets its own *grumpy* face and a 💢 bubble.
- **Nothing is written or shared.** No colony-file field, no snapshot field. Friends' bots join
  in on your screen only; their screen runs its own.

## Scenes

| Scene | Size | What happens | Bubbles / face |
|---|---|---|---|
| Chat | 2 | walk together, face each other, take turns gesturing | 💬 alternating; happy / wink |
| Group chat | 3–5 | gather in a small ring facing its middle, take turns | 💬 hops round the ring; happy |
| Argument | 2 | face off, stomp, then turn and walk apart | 💢; grumpy |
| Heartbreak + comfort | 2 | one sits down sad; the other walks over, stands beside it; it stands up cheered | 💔 then 😢 from the sad one, ❤️ from the comforter; sad → love |
| Play | 2–4 | kick a ball between them (a code-built ball, arcs and bounces), or chase and jump | ⚽ / 🎵; cheer / happy |

Bubbles are a new instanced billboard layer like the status badges, drawn from paths in one
atlas, smaller than badges and placed beside the head rather than above it. Scenes last 6–15 s.

## What starts a scene

- **Heartbreak** — a thread is archived (or a friend's thread disappears from their snapshot):
  one idle bot from the same repo becomes heartbroken; the nearest other idle bot comforts it.
- **Play** — a thread finishes a run (`working` → `idle`): it invites an idle repo-mate to play.
- **After a war battle** — for a minute, the losing side's idle bots sulk and argue, the winning
  side's play.
- **Ambient** — otherwise, between events, a seeded random picks: chat 45%, group chat 20%,
  play 20%, argument 10%, heartbreak 5%.

Event scenes jump the queue but still obey the limits.

## Limits

- At most one scene per 6 idle bots, never more than 8 at once.
- Each bot rests 30–60 s between scenes.
- Participants are drawn from bots near each other (same zone, or within ~15 units); friends'
  bots socialise within their own settlement.

## Setting

**View → Bot social life**, on by default.

## Testing

Node tests for the planner (eligibility, event → scene, limits, cooldowns, a scene ending when a
participant's status changes, war precedence). A browser check of every scene, with screenshots.
