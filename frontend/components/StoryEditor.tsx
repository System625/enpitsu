"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Highlight from "@tiptap/extension-highlight";
import Placeholder from "@tiptap/extension-placeholder";
import { useEffect, useRef, useState } from "react";

interface StoryEditorProps {
  storyText: string;
  onUpdate?: (newText: string) => void;
  /** When Gemini updates a line, flash-highlight the change */
  pendingHighlight?: { old: string; new: string } | null;
}

export function StoryEditor({ storyText, onUpdate, pendingHighlight }: StoryEditorProps) {
  const [collapsed, setCollapsed] = useState(false);
  const lastExternalText = useRef(storyText);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit,
      Highlight.configure({ multicolor: true }),
      Placeholder.configure({ placeholder: "Your story will appear here once uploaded…" }),
    ],
    content: storyText ? `<p>${storyText.replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>` : "",
    editorProps: {
      attributes: {
        class:
          "prose prose-sm max-w-none focus:outline-none text-skeuo-text leading-relaxed px-3 py-2 min-h-[120px] max-h-[40vh] overflow-y-auto",
      },
    },
    onUpdate: ({ editor }) => {
      const text = editor.getText();
      onUpdate?.(text);
    },
  });

  // When storyText changes externally (e.g. push_story from backend), update editor
  useEffect(() => {
    if (!editor || !storyText) return;
    if (storyText === lastExternalText.current) return;
    lastExternalText.current = storyText;
    const html = `<p>${storyText.replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`;
    editor.commands.setContent(html);
  }, [storyText, editor]);

  // Handle line updates from Gemini — find & replace + flash highlight
  useEffect(() => {
    if (!editor || !pendingHighlight) return;
    const { old: oldText, new: newText } = pendingHighlight;
    const currentHtml = editor.getHTML();

    // Escape special regex chars in old text
    const escaped = oldText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "i");

    if (regex.test(editor.getText())) {
      // Replace in the HTML content
      const updatedHtml = currentHtml.replace(
        oldText,
        `<mark data-color="yellow">${newText}</mark>`
      );
      editor.commands.setContent(updatedHtml);
      lastExternalText.current = editor.getText();

      // Remove highlight after 3 seconds
      setTimeout(() => {
        if (!editor.isDestroyed) {
          editor.commands.unsetHighlight();
        }
      }, 3000);
    }
  }, [pendingHighlight, editor]);

  if (!storyText) return null;

  return (
    <div className="flex flex-col bg-skeuo-surface rounded-xl border border-skeuo-border shadow-neo overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center justify-between px-3 py-2 bg-skeuo-surface-raised border-b border-skeuo-border hover:bg-skeuo-base transition-colors"
      >
        <span className="text-xs font-bold text-skeuo-text uppercase tracking-wider flex items-center gap-1.5">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          Story Script
        </span>
        <svg
          className={`w-4 h-4 text-skeuo-text-muted transition-transform ${collapsed ? "" : "rotate-180"}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Editor body */}
      {!collapsed && (
        <EditorContent editor={editor} />
      )}
    </div>
  );
}
