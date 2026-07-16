import React from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "../app/ErrorBoundary";
import { LedgerApp } from "../app/LedgerApp";
import "../app/globals.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><ErrorBoundary><LedgerApp /></ErrorBoundary></React.StrictMode>,
);
