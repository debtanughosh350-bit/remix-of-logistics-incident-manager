import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";
import html from "../app/index.html?raw";

export const Route = createFileRoute("/")({
  server: {
    handlers: {
      GET: () =>
        new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
    },
  },
});
