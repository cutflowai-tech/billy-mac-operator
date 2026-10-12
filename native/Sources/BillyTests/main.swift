// BillyTests: self-hosted test runner.
//   swift run BillyTests [name-filter]
// Optional live check against a running daemon: BILLY_LIVE_DATA_DIR=<dataDir>.
import BillyKit
import Foundation

let runner = TestRunner()

// MARK: HTTP framing

runner.test("http.request omits Origin and sets Content-Length") {
    let r = HTTPRequest(method: "POST", path: "/v1/stop", headers: [("Origin", "http://evil"), ("Host", "billyd")], body: Data("{}".utf8))
    let wire = String(decoding: r.serialize(), as: UTF8.self)
    try expect(wire.hasPrefix("POST /v1/stop HTTP/1.1\r\n"))
    try expect(!wire.lowercased().contains("origin"), "Origin must never be sent")
    try expect(wire.contains("Content-Length: 2\r\n"))
    try expect(wire.hasSuffix("\r\n\r\n{}"))
}

runner.test("http.parser content-length, byte at a time") {
    let raw = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}"
    var p = HTTPResponseParser()
    for b in raw.utf8 { try p.feed(Data([b])) }
    let r = try unwrap(p.result)
    try expectEqual(r.status, 200)
    try expectEqual(r.headers["content-type"], "application/json")
    try expectEqual(String(decoding: r.body, as: UTF8.self), "{\"ok\":true}")
}

runner.test("http.parser chunked with extensions and trailers") {
    let raw = "HTTP/1.1 201 Created\r\nTransfer-Encoding: chunked\r\n\r\n4;x=y\r\n{\"a\"\r\n6\r\n:12345\r\n1\r\n}\r\n0\r\nX-T: 1\r\n\r\n"
    var p = HTTPResponseParser()
    let bytes = Array(raw.utf8)
    try p.feed(Data(bytes[0..<30])); try expect(p.result == nil, "must wait for the last chunk")
    try p.feed(Data(bytes[30...]))
    let r = try unwrap(p.result)
    try expectEqual(r.status, 201)
    try expectEqual(String(decoding: r.body, as: UTF8.self), "{\"a\":12345}")
}

runner.test("http.parser close-delimited body and truncation") {
    var p = HTTPResponseParser()
    try p.feed(Data("HTTP/1.1 200 OK\r\n\r\n[1,2]".utf8))
    try expectEqual(String(decoding: try p.finish().body, as: UTF8.self), "[1,2]")
    var q = HTTPResponseParser()
    try q.feed(Data("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc".utf8))
    try await expectThrows({ _ = try q.finish() }) { ($0 as? HTTPError) == .incomplete }
    var m = HTTPResponseParser()
    try await expectThrows({ try m.feed(Data("garbage\r\n\r\n".utf8)) }) { if case .malformed = $0 as? HTTPError { return true }; return false }
}

// MARK: client over a real Unix socket

runner.test("client.status over UDS sends bearer token, no Origin") {
    let server = try FakeDaemon { _ in .json(200, Samples.status) }
    defer { server.shutdown() }
    let client = BillyClient(paths: BillyPaths(dataDir: server.dir))
    let s = try await client.status()
    try expectEqual(s.pid, 99956)
    try expectEqual(s.stop.stopped, false)
    let req = try unwrap(server.requests.first)
    try expectEqual(req.method, "GET"); try expectEqual(req.path, "/v1/status")
    try expectEqual(req.headers["authorization"], "Bearer \(server.token)")
    try expect(req.headers["origin"] == nil)
}

runner.test("client.createTask posts goal, id and source voice") {
    let server = try FakeDaemon { _ in .json(201, Samples.createTask) }
    defer { server.shutdown() }
    let client = BillyClient(paths: BillyPaths(dataDir: server.dir))
    let r = try await client.createTask(goal: "open calculator", clientMessageID: "voice-12345678", source: .voice)
    try expectEqual(r.task_id, "f8899b12-2370-4243-9fd8-767d0bb17815")
    let req = try unwrap(server.requests.first)
    try expectEqual(req.method, "POST"); try expectEqual(req.path, "/v1/tasks")
    try expectEqual(req.headers["content-type"], "application/json")
    try expectEqual(req.json?["source"] as? String, "voice")
    try expectEqual(req.json?["goal"] as? String, "open calculator")
    try expectEqual(req.json?["client_message_id"] as? String, "voice-12345678")
}

runner.test("client.provider activates a stored key without changing budget or authority") {
    let server = try FakeDaemon { r in
        if r.path == "/v1/provider" {
            return .json(200, #"{"kind":"anthropic_api","planner_model":null,"fast_model":null,"budget_scope":"provider-total"}"#)
        }
        if r.path == "/v1/provider/discover" {
            return .json(200, #"{"available":["claude-test-model"],"roles":{"planner":{"model":"claude-test-model","ok":true}}}"#)
        }
        return .json(404, #"{"error":"unexpected setup side effect"}"#)
    }
    defer { server.shutdown() }
    let client = BillyClient(paths: BillyPaths(dataDir: server.dir))
    let config = try await client.activateAnthropic()
    try expectEqual(config.kind, "anthropic_api")
    let discovery = try await client.discoverProviderModels()
    try expectEqual(discovery.roles["planner"]?.ok, true)
    try expectEqual(server.requests.map(\.path), ["/v1/provider", "/v1/provider/discover"])
    let activation = try unwrap(server.requests.first)
    try expectEqual(activation.method, "PUT")
    try expectEqual(activation.json?["kind"] as? String, "anthropic_api")
    try expect(activation.json?["planner_model"] == nil, "omitted model preserves core configuration")
    try expectEqual(activation.json?.count, 1, "credential never travels through HTTP")
    _ = try await client.activateAnthropic(plannerModel: "  claude-test-model  ")
    try expectEqual(server.requests.last?.json?["planner_model"] as? String, "claude-test-model")
}

runner.test("client.provider surfaces activation and discovery failures") {
    let server = try FakeDaemon { r in
        r.path == "/v1/provider" ? .json(400, #"{"error":"invalid model id"}"#)
            : .json(409, #"{"error":"no provider configured"}"#)
    }
    defer { server.shutdown() }
    let client = BillyClient(paths: BillyPaths(dataDir: server.dir))
    try await expectThrows({ _ = try await client.activateAnthropic(plannerModel: "bad") }) {
        ($0 as? ClientError) == .http(400, "invalid model id")
    }
    try await expectThrows({ _ = try await client.discoverProviderModels() }) {
        ($0 as? ClientError) == .http(409, "no provider configured")
    }
}

runner.test("client decodes chunked and close-delimited responses") {
    let server = try FakeDaemon { r in r.path == "/v1/doctor" ? .chunked(200, Samples.doctor, chunkSize: 37) : .closeDelimited(200, Samples.events) }
    defer { server.shutdown() }
    let client = BillyClient(paths: BillyPaths(dataDir: server.dir))
    let d = try await client.doctor()
    try expectEqual(d.checks.count, 10)
    let e = try await client.events(after: 0)
    try expectEqual(e.map(\.seq), [1, 2, 3, 4, 5])
    try expectEqual(server.requests.last?.path, "/v1/events?after=0")
}

runner.test("client maps error bodies and missing daemon") {
    let server = try FakeDaemon { _ in .json(404, #"{"error":"unknown task"}"#) }
    defer { server.shutdown() }
    let client = BillyClient(paths: BillyPaths(dataDir: server.dir))
    try await expectThrows({ _ = try await client.task("00000000-0000-0000-0000-000000000000") }) {
        ($0 as? ClientError) == .http(404, "unknown task")
    }
    // Wrong token → 401 from the same auth rule as billyd.
    try "wrong\n".write(toFile: client.paths.tokenPath, atomically: true, encoding: .utf8)
    try await expectThrows({ _ = try await client.status() }) { ($0 as? ClientError) == .http(401, "unauthorized") }
    // No socket at all → "not running", which the UI shows as such.
    let gone = BillyClient(paths: BillyPaths(dataDir: URL(fileURLWithPath: "/tmp/billy-no-such-dir")))
    try await expectThrows({ _ = try await gone.status() }) { ($0 as? ClientError).map { if case .noToken = $0 { return true }; return false } ?? false }
    try FileManager.default.createDirectory(atPath: "/tmp/bt-nosock/run", withIntermediateDirectories: true)
    try "t\n".write(toFile: "/tmp/bt-nosock/run/api.token", atomically: true, encoding: .utf8)
    defer { try? FileManager.default.removeItem(atPath: "/tmp/bt-nosock") }
    let noSock = BillyClient(paths: BillyPaths(dataDir: URL(fileURLWithPath: "/tmp/bt-nosock")))
    try await expectThrows({ _ = try await noSock.status() }) { ($0 as? TransportError)?.isNotRunning == true }
}

runner.test("paths honour BILLY_DATA_DIR") {
    let p = BillyPaths.resolve(environment: ["BILLY_DATA_DIR": "/tmp/claude-501/bnat"])
    try expectEqual(p.socketPath, "/tmp/claude-501/bnat/run/billyd.sock")
    try expectEqual(p.tokenPath, "/tmp/claude-501/bnat/run/api.token")
    let d = BillyPaths.resolve(environment: [:])
    try expect(d.dataDir.path.hasSuffix("Library/Application Support/Billy"), d.dataDir.path)
}

// MARK: JSON decoding of real shapes

runner.test("decode.status / doctor / tasks / detail / events") {
    let s = try decode(StatusResponse.self, Samples.status)
    try expectEqual(s.ownsDesktop, false)
    let stopped = try decode(StatusResponse.self, Samples.statusStopped)
    try expect(stopped.stop.stopped); try expectEqual(stopped.tasks["PAUSED_BY_OWNER"], 1)
    let d = try decode(DoctorReport.self, Samples.doctor)
    try expect(!d.ok); try expect(d.needsOnboarding)
    try expectEqual(d.check("provider.credential")?.fix, "security add-generic-password -U -s com.billy.provider.anthropic -a default -w")
    try expectEqual(d.check("remote.telegram")?.status, .warn)
    let t = try decode([TaskSummary].self, Samples.tasks)
    try expectEqual(t.count, 2); try expectEqual(t[0].wait_reason, "stopped by local-app")
    let detail = try decode(TaskDetail.self, Samples.taskDetail)
    try expectEqual(detail.events.count, 4)
    try expectEqual(detail.events[1].payload?["to"]?.stringValue, "PLANNING")
    let full = try decode(TaskDetail.self, Samples.taskDetailWithAttempt)
    try expectEqual(full.attempts.count, 2); try expectEqual(full.attempts[1].error, "ENOENT")
    try expectEqual(full.result?["bytes"], .number(12))
    try expectEqual(try decode([EventRow].self, Samples.events).last?.domain, "task")
}

runner.test("decode.command / stop / policy / budget") {
    let c = try decode(CommandResponse.self, Samples.createTask)
    try expectEqual(c.duplicate, false); try expectEqual(c.task?.status, "RECEIVED")
    let ack = try decode(StopAck.self, Samples.stopAck)
    try expectEqual(ack.tasks_paused.count, 1)
    try expectEqual(try decode(StopLatch.self, Samples.stopClear).stopped, false)
    let g = try decode(Grant.self, Samples.policy)
    try expectEqual(g.scope.allowed_effects, [.READ_ONLY]); try expectEqual(g.scope.delegation.max_depth, 1)
    try expect(try decode(Grant?.self, "null") == nil, "GET /v1/policy returns null before onboarding")
    try expectEqual(try decode([BudgetRow].self, Samples.budget).first?.ceiling_micros, 5_000_000)
    // desktop_owner is optional and forward compatible.
    let owned = try decode(StatusResponse.self, Samples.status.replacingOccurrences(of: #""device_id""#, with: #""desktop_owner":{"task_id":"x"},"device_id""#))
    try expect(owned.ownsDesktop)
}

// MARK: view-model logic

runner.test("tasks.grouping, filters and counts") {
    try expectEqual(TaskGroup.of("RUNNING"), .active)
    try expectEqual(TaskGroup.of("WAITING_BUDGET"), .waiting)
    try expectEqual(TaskGroup.of("PAUSED_BY_OWNER"), .paused)
    try expectEqual(TaskGroup.of("BLOCKED_EXTERNAL"), .blocked)
    try expectEqual(TaskGroup.of("FAILED"), .ended)
    try expect(TaskFilter.all.matches("COMPLETED"))
    try expect(TaskFilter.waiting.matches("WAITING_PROVIDER"))
    try expect(!TaskFilter.active.matches("COMPLETED"))
    let c = TaskCounts(["RUNNING": 2, "PLANNING": 1, "PAUSED_BY_OWNER": 3, "BLOCKED_EXTERNAL": 1, "WAITING_PERMISSION": 2, "COMPLETED": 9])
    try expectEqual(c.running, 3); try expectEqual(c.paused, 3); try expectEqual(c.needsAttention, 3); try expectEqual(c.completed, 9)
}

runner.test("store.filteredTasks follows filter") {
    let api = RecordingAPI()
    let store = AppStore(api: api)
    await store.tick()
    try expectEqual(store.tasks.count, 2)
    store.filter = .paused
    try expectEqual(store.filteredTasks.map(\.status), ["PAUSED_BY_OWNER"])
    store.filter = .active
    try expectEqual(store.filteredTasks.map(\.status), ["RUNNING"])
}

runner.test("store.bootstrap fast-forwards the event cursor across pages") {
    let api = RecordingAPI()
    api.allEvents = (1...1203).map { RecordingAPI.event($0) }
    let store = AppStore(api: api)
    await store.tick()
    try expect(store.isConnected); try expect(store.bootstrapped)
    try expectEqual(store.eventCursor, 1203)
    try expectEqual(api.calls.filter { $0.hasPrefix("GET /v1/events") }, ["GET /v1/events?after=0", "GET /v1/events?after=500", "GET /v1/events?after=1000"])
}

runner.test("store.sync refreshes tasks only for task events, and selected detail") {
    let api = RecordingAPI()
    let store = AppStore(api: api)
    await store.tick()
    let before = api.calls.filter { $0 == "GET /v1/tasks" }.count
    api.allEvents = [RecordingAPI.event(1, domain: "daemon", entity: "billyd")]
    let changed = await store.syncEvents()
    try expect(!changed)
    try expectEqual(api.calls.filter { $0 == "GET /v1/tasks" }.count, before)
    await store.select("f8899b12-2370-4243-9fd8-767d0bb17815")
    api.allEvents.append(RecordingAPI.event(2, entity: "f8899b12-2370-4243-9fd8-767d0bb17815"))
    let detailCalls = api.calls.filter { $0.hasPrefix("GET /v1/tasks/") }.count
    let changed2 = await store.syncEvents()
    try expect(changed2)
    try expectEqual(api.calls.filter { $0 == "GET /v1/tasks" }.count, before + 1)
    try expectEqual(api.calls.filter { $0.hasPrefix("GET /v1/tasks/") }.count, detailCalls + 1)
    try expectEqual(store.eventCursor, 2)
}

runner.test("store reports a stopped core as not running") {
    let api = RecordingAPI()
    api.failWith = TransportError.socket("connect", ECONNREFUSED)
    let store = AppStore(api: api)
    await store.tick()
    if case .notRunning = store.connection {} else { throw TestFailure(message: "got \(store.connection)", location: "connection") }
    try expect(!store.bootstrapped)
}

runner.test("store.submitTask ignores blank input") {
    let api = RecordingAPI()
    let store = AppStore(api: api)
    let blank = await store.submitTask(goal: "   \n")
    try expect(blank == nil)
    try expect(api.created.isEmpty)
    let id = await store.submitTask(goal: " hi ")
    try expectEqual(id, "f8899b12-2370-4243-9fd8-767d0bb17815")
    try expectEqual(api.created.first?.goal, "hi"); try expectEqual(api.created.first?.source, .localApp)
}

runner.test("menu Stop posts /v1/stop over the socket") {
    let server = try FakeDaemon { r in
        switch r.path {
        case "/v1/stop": return .json(200, Samples.stopAck)
        case "/v1/status": return .json(200, Samples.statusStopped)
        default: return .json(200, "[]")
        }
    }
    defer { server.shutdown() }
    let store = AppStore(api: BillyClient(paths: BillyPaths(dataDir: server.dir)))
    await store.stop()   // AppModel.emergencyStop (menu, toolbar, ⌘⇧.) calls exactly this
    let stops = server.requests.filter { $0.path == "/v1/stop" }
    try expectEqual(stops.count, 1)
    try expectEqual(stops[0].method, "POST")
    try expect((stops[0].json?["reason"] as? String)?.isEmpty == false)
    try expectEqual(store.lastStopAck?.generation, 1)
    try expect(store.isStopped, "status refreshed after stop")
}

runner.test("resumeAll clears stop then resumes owner-paused tasks") {
    let api = RecordingAPI()
    api.statusValue = try decode(StatusResponse.self, Samples.statusStopped)
    let store = AppStore(api: api)
    await store.tick()
    await store.resumeAll()
    let ctl = api.calls.filter { $0.hasPrefix("POST") }
    try expectEqual(ctl, ["POST /v1/stop/clear", "POST /v1/tasks/de272dd9-4547-4026-bacc-3978cbd097b8/resume"])
}

// MARK: voice state machine

runner.test("voice start → recording → cancel → idle, no POST, mic off") {
    let api = RecordingAPI()
    let store = AppStore(api: api)
    let rec = FakeRecognizer()
    let voice = VoiceController(recognizer: rec) { await store.submitTask(goal: $0, source: .voice) }
    try expect(!voice.isRecording)
    await voice.start()
    try expect(voice.isRecording); try expect(rec.isCapturing)
    rec.hear("delete everything")
    try expectEqual(voice.transcript, "delete everything")
    voice.cancel()
    try expectEqual(voice.state, .idle); try expect(!voice.isRecording)
    try expect(!rec.isCapturing, "microphone must be off after cancel")
    try expectEqual(voice.transcript, "")
    try expect(api.calls.filter { $0.hasPrefix("POST") }.isEmpty, "cancelled recording must not create a task")
}

runner.test("voice start → recording → send → POST source voice") {
    let api = RecordingAPI()
    let store = AppStore(api: api)
    let rec = FakeRecognizer()
    let voice = VoiceController(recognizer: rec) { await store.submitTask(goal: $0, source: .voice) }
    await voice.start()
    rec.hear("open")
    rec.hear("open calculator")
    rec.finalText = "Open Calculator"
    let id = await voice.send()
    try expectEqual(id, "f8899b12-2370-4243-9fd8-767d0bb17815")
    try expectEqual(voice.state, .idle); try expect(!rec.isCapturing)
    try expectEqual(api.created.count, 1)
    try expectEqual(api.created[0].goal, "Open Calculator"); try expectEqual(api.created[0].source, .voice)
    try expectEqual(api.calls.filter { $0.hasPrefix("POST") }, ["POST /v1/tasks voice"])
}

runner.test("voice empty transcript or denied permission creates no task") {
    let api = RecordingAPI()
    let store = AppStore(api: api)
    let rec = FakeRecognizer()
    let voice = VoiceController(recognizer: rec) { await store.submitTask(goal: $0, source: .voice) }
    await voice.start()
    let none = await voice.send()
    try expect(none == nil)
    if case .failed = voice.state {} else { throw TestFailure(message: "expected failed, got \(voice.state)", location: "voice") }
    try expect(!rec.isCapturing)
    voice.dismissError()
    rec.authorized = false
    await voice.start()
    try expect(!voice.isRecording); try expectEqual(rec.starts, 1)
    try expect(api.created.isEmpty)
    // Sending while not recording is a no-op.
    let none2 = await voice.send()
    try expect(none2 == nil)
}

// MARK: policy draft, diagnostics

runner.test("grant proposal matches onboarding defaults and schema") {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    let d = GrantDraft.proposal(home: "/Users/owner", now: now)
    let u = d.update()
    try expectEqual(u.scope.file_roots, ["/Users/owner/Billy Workspace"])
    try expectEqual(u.scope.apps, ["com.apple.calculator", "com.apple.TextEdit", "com.apple.finder"])
    try expectEqual(u.scope.allowed_effects, [.READ_ONLY, .IDEMPOTENT_WRITE, .NON_IDEMPOTENT_EFFECT])
    try expectEqual(u.scope.tool_classes, ["file", "desktop", "app", "api.message"])
    try expectEqual(ISODate.parse(u.expires_at), now.addingTimeInterval(90 * 86400))
    let obj = try JSONSerialization.jsonObject(with: JSONEncoder().encode(u)) as! [String: Any]
    let scope = obj["scope"] as! [String: Any]
    let required = ["apps", "file_roots", "browser_profiles", "domains", "account_ids", "tool_classes", "allowed_effects",
                    "secret_references", "network_destinations", "foreground", "spend_scopes", "protected_actions", "delegation", "model_egress", "recipients"]
    try expectEqual(Set(scope.keys), Set(required))
    try expect(d.problems(now: now).isEmpty)
    var bad = d; bad.fileRoots.append("relative"); bad.effects = []
    try expectEqual(bad.problems(now: now).count, 2)
    try expect(!d.problems(now: now.addingTimeInterval(100 * 86400)).isEmpty, "expired drafts are rejected")
}

runner.test("grant edit preserves fields the UI does not show") {
    let g = try decode(Grant.self, Samples.policy)
    var d = GrantDraft(grant: g)
    d.apps.append("com.apple.TextEdit")
    var base = g.scope; base.domains = ["example.com"]
    let s = d.scope(base: base)
    try expectEqual(s.domains, ["example.com"])
    try expectEqual(s.apps, ["com.apple.calculator", "com.apple.TextEdit"])
}

runner.test("diagnostics export is redacted") {
    var status = try decode(StatusResponse.self, Samples.status)
    status.device_id = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAA"
    let doctor = try decode(DoctorReport.self, Samples.doctor)
    let data = try DiagnosticsExport.make(status: status, doctor: doctor, connection: .connected, service: "on",
                                          appVersion: "0.1.0", home: "/Users/ahri")
    let text = String(decoding: data, as: UTF8.self)
    try expect(!text.contains("/Users/ahri"), "home path must be redacted")
    try expect(!text.contains("sk-ant-api03"), "API keys must be redacted")
    try expect(text.contains("~/.hermes/node/bin/node"))
    try expect(DiagnosticsExport.redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz").contains("[REDACTED]"))
    _ = try JSONSerialization.jsonObject(with: data)
}

// MARK: optional live daemon

if let live = ProcessInfo.processInfo.environment["BILLY_LIVE_DATA_DIR"] {
    runner.test("live daemon: status, doctor, tasks, events decode") {
        let client = BillyClient(paths: BillyPaths(dataDir: URL(fileURLWithPath: live)))
        let s = try await client.status()
        try expect(s.pid > 0)
        _ = try await client.doctor()
        _ = try await client.tasks(limit: 50)
        _ = try await client.events(after: 0)
        _ = try await client.policy()
        _ = try await client.budget()
    }
} else {
    runner.skip("live daemon", reason: "set BILLY_LIVE_DATA_DIR to run against a real billyd")
}

// Mutating end-to-end flow through AppStore against a THROWAWAY daemon:
// onboarding grant + budget, typed and voice tasks, stop, clear, resume.
if let flow = ProcessInfo.processInfo.environment["BILLY_LIVE_FLOW_DATA_DIR"] {
    runner.test("live flow: onboarding, tasks, voice, stop/clear via AppStore") {
        let store = AppStore(api: BillyClient(paths: BillyPaths(dataDir: URL(fileURLWithPath: flow))))
        await store.tick()
        try expect(store.isConnected, "\(store.connection)")
        try expect(store.doctor?.needsOnboarding == true, "fresh daemon should need onboarding")
        let ok = await store.savePolicy(GrantDraft.proposal())
        try expect(ok, store.lastError ?? "")
        try expectEqual(store.policy?.scope.apps.count, 3)
        try expect(store.doctor?.needsOnboarding == false, "grant should satisfy policy.default_grant")
        let saved = await store.saveBudget(scope: "provider-total", ceilingUSD: 3, period: "total")
        try expect(saved, store.lastError ?? "")
        try expectEqual(store.budgets.first?.ceiling_micros, 3_000_000)
        let typed = try unwrap(await store.submitTask(goal: "List the files in Billy Workspace"))
        let rec = FakeRecognizer()
        let voice = VoiceController(recognizer: rec) { await store.submitTask(goal: $0, source: .voice) }
        await voice.start(); rec.hear("open calculator"); voice.cancel()
        await voice.start(); rec.hear("open calculator")
        let spoken = try unwrap(await voice.send())
        try expect(typed != spoken)
        _ = await store.syncEvents()
        try expect(store.tasks.contains { $0.task_id == spoken })
        try expectEqual(store.tasks.filter { $0.goal == "open calculator" }.count, 1, "cancelled recording created no task")
        await store.stop(reason: "native live flow test")
        try expect(store.isStopped)
        try expect(store.lastStopAck?.tasks_paused.contains(spoken) == true)
        await store.clearStop()
        try expect(!store.isStopped)
        await store.select(spoken)
        try expectEqual(store.detail?.status, "PAUSED_BY_OWNER")
        try expect(store.detail?.events.contains { $0.kind == "transition" } == true)
        // Leave the voice task paused and the typed one resumed for the UI walkthrough.
        await store.control(typed, .resume)
        await store.stop(reason: "left stopped for screenshot")
    }
}

let filter = CommandLine.arguments.dropFirst().first
exit(await runner.run(filter: filter))
