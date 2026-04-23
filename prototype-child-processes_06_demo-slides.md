# Child Process Monitoring in Electron

---

## The Blind Spot

```
┌─ Electron App ─────────────────────────────────────────────────┐
│                                                                │
│  Main Process + Electron SDK (orchestrates everything)         │
│  ├── Renderer Process        (each window = a process)         │
│  │   └── Web page + Browser SDK  (HTML/JS, like a browser tab) │
│  ├── Renderer Process                                          │
│  │   └── Web page + Browser SDK                                │
│  ├── Utility Process         (background work, sandboxed)      │
│  ├── GPU Process             (compositing, hardware accel)     │
│  └── child_process.spawn()   (external commands: git, ffmpeg)  │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

---

## Prototyping with AI — 4 Sessions

| Session | Focus                                      | Outcome                                                    |
| ------- | ------------------------------------------ | ---------------------------------------------------------- |
| 1       | Landscape research + technical feasibility | Survey of 6 process mechanisms, 3 working prototypes       |
| 2       | RUM data model design                      | Mapping available data points to RUM events                |
| 3       | Full prototype implementation              | Working SDK + playground with 12 Playwright test scenarios |
| 4       | Synthesis                                  | Conclusion doc with prioritized next steps                 |

---

## Demo

---

## Next Steps

```
dd-trace evaluation ──→ exec/spawn monkey-patching (or dd-trace) ─┐
                                                                  ├──→ exec/spawn collection
data model agreement ─────────────────────────────────────────────┘
                              ├──→ utility process monitoring
                              └──→ renderer process views
```

---

## AI Usage — Key Takeaways

- **Self-validation infrastructure is the highest-leverage investment** — building a Playwright + mock intake harness let the AI agent iterate autonomously
