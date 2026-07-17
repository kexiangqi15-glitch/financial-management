import React from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "../app/ErrorBoundary";
import { LedgerApp } from "../app/LedgerApp";
import { CloudSyncProvider } from "../app/CloudSyncProvider";
import "../app/globals.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><ErrorBoundary><CloudSyncProvider><LedgerApp /></CloudSyncProvider></ErrorBoundary></React.StrictMode>,
);
