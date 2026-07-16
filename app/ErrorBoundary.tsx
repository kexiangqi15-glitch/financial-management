"use client";
import React from "react";

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: string }> {
  state = { error: "" };
  static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error.message : "未知错误" }; }
  componentDidCatch(error: unknown) { console.error("Qinglan UI error", error); }
  render() {
    if (this.state.error) return <div className="boot error"><h1>页面遇到问题</h1><p>{this.state.error}</p><button onClick={() => location.reload()}>重新加载</button></div>;
    return this.props.children;
  }
}
