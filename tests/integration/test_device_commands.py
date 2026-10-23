"""Companion execution flow against a live API stack."""
from __future__ import annotations
import asyncio, json, os, urllib.error, urllib.request, uuid
import pytest

API = os.environ.get("API_URL", "").rstrip("/")
pytestmark = pytest.mark.skipif(not API, reason="API_URL is required for live device command tests")

class Client:
    def __init__(self): self.cookie=""
    def call(self, method, path, body=None):
        req=urllib.request.Request(API+path,data=None if body is None else json.dumps(body).encode(),method=method)
        if body is not None:req.add_header("Content-Type","application/json")
        if self.cookie:req.add_header("Cookie",self.cookie)
        try:
            with urllib.request.urlopen(req,timeout=15) as r:
                sc=r.headers.get("Set-Cookie","")
                if "teammates_session=" in sc:self.cookie=sc.split(";",1)[0]
                payload=r.read()
                return r.status,json.loads(payload) if payload else {}
        except urllib.error.HTTPError as e:
            return e.code,e.read()

def login():
    c=Client(); status,_=c.call("POST","/api/auth/login",{"username":os.getenv("OWNER_USERNAME","saad"),"password":os.getenv("OWNER_PASSWORD","teammates-dev")});assert status==200
    return c

def pair(c):
    status,b=c.call("POST","/api/devices/pair",{});assert status==200,b
    status,d=c.call("POST","/api/devices/pair/complete",{"code":b["code"],"name":"pytest companion","os":"linux","version":"0.5.0"});assert status==200,d
    return d

def test_offline_off_invalid_and_foreign():
    c=login(); d=pair(c); path=f"/api/devices/{d['id']}/commands"
    assert c.call("POST",path,{"command":"   "})[0]==400
    assert c.call("POST",path,{"command":"echo x"})[0]==409
    foreign=str(uuid.uuid4())
    assert c.call("POST",f"/api/devices/{foreign}/commands",{"command":"echo x"})[0]==404
    assert c.call("PATCH",f"/api/devices/{d['id']}",{"execution":"off"})[0]==200

def test_approve_and_deny_path():
    async def run():
        try: import websockets
        except ImportError: pytest.skip("websockets package is not installed")
        c=login(); d=pair(c); device=str(d["id"]); token=d["deviceToken"]
        await asyncio.sleep(0)
        ws_url=API.replace("https://","wss://").replace("http://","ws://")+f"/api/devices/{device}/connect"
        options={"additional_headers":{"Authorization":"Bearer "+token}}
        try:
            peer=websockets.connect(ws_url,**options)
        except TypeError:
            options={"extra_headers":{"Authorization":"Bearer "+token}}
            peer=websockets.connect(ws_url,**options)
        async with peer as ws:
            assert json.loads(await ws.recv())["type"]=="welcome"
            for decision in ("approved","denied"):
                status,body=await asyncio.to_thread(c.call,"POST",f"/api/devices/{device}/commands",{"command":"echo companion"})
                assert status==202,body
                frame=json.loads(await ws.recv()); assert frame["type"]=="command"
                await ws.send(json.dumps({"type":"decision","requestId":frame["requestId"],"decision":decision}))
                for _ in range(30):
                    status,detail=await asyncio.to_thread(c.call,"GET",f"/api/devices/{device}/commands/{frame['requestId']}")
                    if detail.get("status")==decision:break
                    await asyncio.sleep(.1)
                assert detail["status"]==decision
                if decision=="approved":
                    result={"type":"result","requestId":frame["requestId"],"exitCode":0,"stdout":"ok","stderr":"","truncated":False,"durationMs":3,"timedOut":False}
                    await ws.send(json.dumps(result))
                    for _ in range(30):
                        _,detail=await asyncio.to_thread(c.call,"GET",f"/api/devices/{device}/commands/{frame['requestId']}")
                        if detail.get("status")=="completed":break
                        await asyncio.sleep(.1)
                    assert detail["status"]=="completed"
    asyncio.run(run())
