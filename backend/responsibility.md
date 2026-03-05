# Backend Developer - Responsibilities & Guide

## Project: Enpitsu - Real-Time AI Comic Book Co-Creator

Enpitsu is a **live AI agent** that turns stories (PDF/Word uploads) into comic book panels through an interactive, real-time co-creation experience. The user uploads a story, and a Gemini-powered agent collaborates with them via voice and text to storyboard and generate comic panels dynamically.

**This is NOT a static "upload and wait" tool.** The agent must interact with the user in real-time — asking creative questions, taking voice/text feedback, and updating panels live.

---

## Your Core Responsibilities

### 1. Gemini Agent & Live API Integration
- Build the core AI agent using **Gemini 1.5 Pro or Flash** via the **Google GenAI SDK** or **Google Agent Development Kit (ADK)**.
- Implement **bidirectional streaming** so the agent can:
  - Receive user audio/text input in real-time
  - Stream back audio responses (the agent "talking" about creative decisions)
  - Stream back generated image data/URLs for comic panels
- The agent should act as a **Creative Director** — analyzing the uploaded story, proposing panel layouts, art styles, and asking the user for preferences.

### 2. Story Processing Pipeline
- Accept uploaded PDF/Word files from the frontend.
- Parse and extract the story text.
- Break the story into scenes/chapters suitable for comic panel generation.
- Feed the structured story data into the Gemini agent for storyboarding.

### 3. Image Generation
- Use **Gemini's Gen Media capabilities** (Vertex AI Creative Studio) to generate comic panels based on story scenes.
- Support different art styles (Manhwa, Manga, Western comic, etc.) as directed by the user through the agent.
- Generate captions/dialogue overlays for panels.

### 4. WebSocket/Streaming Server
- Expose a **WebSocket endpoint** for the frontend to connect to.
- Handle bidirectional communication:
  - **Incoming**: user audio chunks, text commands, style preferences
  - **Outgoing**: agent audio responses, generated panel images/URLs, status updates
- Manage session state for each connected user.

### 5. API Endpoints
- `POST /upload` — Accept story file uploads (PDF/Word), return a session ID
- `WS /session/{id}` — WebSocket for real-time agent interaction
- Additional REST endpoints as needed for panel history, export, etc.

---

## Required Tech Stack

| Component | Requirement |
|-----------|------------|
| AI Model | **Gemini 1.5 Pro** or **Gemini 1.5 Flash** |
| SDK | **Google GenAI SDK** or **Google Agent Development Kit (ADK)** |
| Streaming | Bidirectional streaming via ADK or Live API |
| Cloud | Must run on **Google Cloud Services** |

---

## Key Resources

### Gemini Live API & Streaming
- **Live API Notebooks & Apps**: https://github.com/GoogleCloudPlatform/generative-ai/tree/main/gemini/multimodal-live-api
  - Reference implementations for real-time bidirectional streaming with Gemini
- **ADK Bidirectional Streaming Guide (Part 1)**: https://google.github.io/adk-docs/streaming/dev-guide/part1/
  - Official step-by-step guide for building streaming agents with ADK
- **ADK Bidi-Streaming Demo Repo**: https://github.com/google/adk-samples/tree/main/python/agents/bidi-demo
  - Working sample implementation — great starting point
- **Visual Guide to ADK Bidi-Streaming**: https://medium.com/google-cloud/adk-bidi-streaming-a-visual-guide-to-real-time-multimodal-ai-agent-development-62dd08c81399
  - Illustrated walkthrough of ADK streaming architecture

### Image & Media Generation
- **Gen Media + Live API Sample App**: https://github.com/GoogleCloudPlatform/generative-ai/tree/main/vision/sample-apps/genmedia-live
  - Combines media generation with streaming — directly relevant to our use case
- **Vertex AI Vision / Gen Media**: https://github.com/GoogleCloudPlatform/generative-ai/tree/main/vision
  - Image and video generation capabilities
- **MCP Servers for Gen Media**: https://github.com/GoogleCloudPlatform/vertex-ai-creative-studio/tree/main/experiments/mcp-genmedia
  - Model Context Protocol integration for Google Cloud media services

### Reference Apps
- **Immersive Language Learning with Live API**: https://github.com/ZackAkil/immersive-language-learning-with-live-api
  - Production-ready example of Live API with multimodal interaction — good architecture reference
- **Shopper's Concierge Demo**: https://www.youtube.com/watch?v=Hwx94smxT_0
  - Example of a live agent with real-time interaction

### Quick Start
- **5-Minute ADK Tutorial**: https://www.youtube.com/watch?v=vLUkAGeLR1k
- **Google Cloud Credits**: https://forms.gle/rKNPXA1o6XADvQGb7 — apply for free credits

---

## What the Frontend Expects From You

The frontend will connect via WebSocket and expects:

1. **Agent audio stream** — PCM/opus audio of the agent speaking (discussing creative decisions, asking questions)
2. **Panel image data** — Either base64-encoded images or URLs to generated comic panels
3. **Status events** — JSON messages indicating agent state (`thinking`, `generating`, `speaking`, `idle`)
4. **Panel metadata** — Scene descriptions, dialogue text, layout info

The frontend will send:
1. **User audio chunks** — Microphone input from the user
2. **Text commands** — Typed instructions/preferences
3. **Style selections** — Art style, layout preferences chosen from the UI

---

## Deadline

**March 16, 2026 @ 8:00pm EDT** — Challenge submission deadline.
