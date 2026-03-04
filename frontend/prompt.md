3. Your "Antigravity" Prompt for Frontend Generation
When you are ready to kick off your Next.js frontend (whether you are using an AI coding assistant like Cursor, Lovable, v0, or giving it back to me), copy and paste this prompt. It sets all the right context:

System Context: You are an expert Next.js and Tailwind CSS developer specializing in highly interactive, multimodal web applications. We are building a frontend for a "Live AI Comic Book Co-Creator" for a hackathon.

Design Language: The UI must use "Modern Skeuomorphism" (tactile, physical-feeling elements, soft inner/outer shadows, realistic textures like subtle paper grain, glassmorphism for overlays, and raised "physical" buttons).

Core Features to Scaffold:

The Workspace (Two-Column Layout): >    - Left Panel: The "Agent Control Center." Needs a highly styled, skeuomorphic "Push to Talk" microphone button for real-time voice interaction with the AI. Needs a sleek file upload dropzone for PDFs/Word docs. Needs tactile toggle switches for styles (Manga, Manhwa, Western Comic).

Right Panel: The "Comic Canvas." A dynamic grid area where generated comic panels and dialogue bubbles will appear in real-time. It should look like a digital drawing board.

State Management: Set up the basic React state for isRecording (audio), agentSpeaking (AI response state), and an array for comicPanels (holding image URLs and text).

Tech Stack: Next.js (App Router), Tailwind CSS (use custom utility classes for the skeuomorphic shadows), and Framer Motion for smooth layout transitions when new panels are added.

Task: Generate the initial page layout (page.tsx) and the CSS configuration required to achieve this specific skeuomorphic aesthetic.