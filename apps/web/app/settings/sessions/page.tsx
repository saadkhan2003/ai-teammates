"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
type Session = { id: string; device: string; browser: string; ip: string; lastActive: string; current: boolean };
export default function SessionsPage() {
 const [rows,setRows]=useState<Session[]>([]); const [error,setError]=useState(""); const [message,setMessage]=useState("");
 async function load(){try{setRows(await api<Session[]>("/api/account/sessions"));setError("");}catch{setError("Could not load sessions.");}}
 useEffect(()=>{void load();},[]);
 async function revoke(id:string){try{await api(`/api/account/sessions/${id}`,{method:"DELETE"});setRows(v=>v.filter(x=>x.id!==id));setMessage("Session signed out.");}catch{setError("Could not sign out that session.");}}
 async function revokeOthers(){try{const r=await api<{revoked:number}>("/api/account/sessions/revoke-others",{method:"POST"});setRows(v=>v.filter(x=>x.current));setMessage(`${r.revoked} other session(s) signed out.`);}catch{setError("Could not sign out other sessions.");}}
 return <div className="flex flex-col gap-5" data-testid="sessions-page"><header className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-lg font-semibold">Sessions & devices</h2><p className="text-sm text-muted-foreground">Review browsers signed in to your account.</p></div><Button variant="outline" onClick={()=>void revokeOthers()}>Sign out all others</Button></header>{rows.length===0&&!error?<div className="rounded-lg border border-line bg-paper p-5 text-sm text-muted-foreground">No active sessions found.</div>:null}<div className="grid gap-3">{rows.map(row=><article key={row.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-paper p-4"><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{row.device||"Device"}{row.current?<span className="ml-2 text-xs text-muted-foreground">This device</span>:null}</p><p className="text-xs text-muted-foreground">{row.browser||"Browser unavailable"} · {row.ip||"IP unavailable"}</p><p className="text-xs text-muted-foreground">Last active {row.lastActive?new Date(row.lastActive).toLocaleString():"Unknown"}</p></div>{!row.current?<Button variant="outline" size="sm" onClick={()=>void revoke(row.id)}>Sign out</Button>:null}</article>)}</div>{message?<p role="status" className="text-sm">{message}</p>:null}{error?<p role="alert" className="text-sm text-clay">{error}</p>:null}</div>
}
