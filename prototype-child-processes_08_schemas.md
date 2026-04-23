# Electron SDK — Architecture Schemas

Diagrams for inclusion in the RFC document.

## Schema 1: Current State (after dd-trace integration — PR #95)

```mermaid
graph TB
    subgraph Electron App
        subgraph Renderer Process
            BP[Browser SDK]
        end

        subgraph Main Process
            DDT[dd-trace]
            SDK[Electron SDK]
        end
    end

    DD[(Datadog)]

    %% Browser SDK → Electron SDK via bridge
    BP -->|"RUM events<br/>(IPC bridge)"| SDK

    %% dd-trace → Electron SDK via diagnostic channel
    DDT -->|"HTTP spans<br/>IPC spans<br/>(diagnostics_channel)"| SDK

    %% Electron SDK internal sources
    SDK -->|"span → resource conversion<br/>RUM data collection<br/>RUM APIs<br/>session + main process view"| SDK

    %% Electron SDK → Datadog
    SDK -->|"enriched events<br/>(HTTP)"| DD

    %% Styling
    classDef sdk fill:#fce8e6,stroke:#d93025
    classDef trace fill:#e6f4ea,stroke:#137333
    classDef browser fill:#fef7e0,stroke:#e37400
    classDef ext fill:#f3e8fd,stroke:#7627bb

    class BP browser
    class DDT trace
    class SDK sdk
    class DD ext
```

## Schema 2: Child Process Monitoring (proposed)

```mermaid
graph TB
    subgraph Electron App
        subgraph Renderer Process
            BP[Browser SDK]
        end

        subgraph Main Process
            DDT_MAIN[dd-trace]
            SDK[Electron SDK]
        end

        subgraph Utility Process
            UE["Utility Export<br/>(@datadog/electron-sdk/utility)"]
            DDT_UTIL[dd-trace]
        end
    end

    DD[(Datadog)]

    %% Browser SDK → Electron SDK via bridge
    BP -->|"RUM events<br/>(IPC bridge)"| SDK

    %% Main process dd-trace → Electron SDK
    DDT_MAIN -->|"HTTP spans<br/>IPC spans<br/>★ command execution spans<br/>(diagnostics_channel)"| SDK

    %% Electron SDK internal sources
    SDK -->|"span → resource conversion<br/>RUM data collection<br/>RUM APIs<br/>session + ★ process views"| SDK

    %% Utility process internal: dd-trace → utility export
    DDT_UTIL -->|"HTTP spans<br/>command execution spans<br/>(diagnostics_channel)"| UE

    %% Utility export collects its own events
    UE -->|"RUM data collection<br/>RUM APIs"| UE

    %% Utility export → Main process via parentPort
    UE -->|"raw events<br/>(parentPort)"| SDK

    %% Electron SDK → Datadog
    SDK -->|"enriched events<br/>(HTTP)"| DD

    %% Styling
    classDef sdk fill:#fce8e6,stroke:#d93025
    classDef trace fill:#e6f4ea,stroke:#137333
    classDef browser fill:#fef7e0,stroke:#e37400
    classDef utility fill:#e8f0fe,stroke:#4285f4
    classDef ext fill:#f3e8fd,stroke:#7627bb

    class BP browser
    class DDT_MAIN,DDT_UTIL trace
    class SDK sdk
    class UE utility
    class DD ext

    %% ★ = new in this schema vs schema 1
```
