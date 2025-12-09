import React, { useEffect, useRef, useState } from "react";

// ★ 請確認這裡的網址與 Apps Script 部署網址一致
const CLOUD_URL = "https://script.google.com/macros/s/AKfycbwHY_vKfpnTb6trh_SCGQznZduwhS43bpDsjhwdLwG9jbv5DH72Q6qT3gw4X-Yc60xB/exec";

/* ---------------- helpers ---------------- */
const formatSeconds = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600).toString().padStart(2, "0");
  const m = Math.floor((s % 3600) / 60).toString().padStart(2, "0");
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return `${h}:${m}:${sec}`;
};

const hashToIndex = (str, n) => {
  let h = 0;
  for (let i = 0; i < (str || "").length; i++)
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % n;
};

const COLORS = [
  "#ffd873", "#c6e9ff", "#ffe0f0", "#e6ffd9", "#f0e6ff",
  "#ffdede", "#e8f5ff", "#fff4d6", "#e6ffe7", "#f6e8ff",
];

export default function App() {
  // --- 核心資料狀態 ---
  const [rounds, setRounds] = useState({});
  const [currentRoundName, setCurrentRoundName] = useState("");
  const [currentMatches, setCurrentMatches] = useState([]);
  const [tableWinners, setTableWinners] = useState({});
  const [pageIndices, setPageIndices] = useState({});
  
  // --- 計時器狀態 ---
  const DEFAULT_MINUTES = 20;
  const [clockSeconds, setClockSeconds] = useState(DEFAULT_MINUTES * 60);
  const [timerRunning, setTimerRunning] = useState(false);

  // --- 系統狀態 ---
  const [lastTs, setLastTs] = useState(0); 
  const [isSyncing, setIsSyncing] = useState(false);
  const [ignoreCloudUntil, setIgnoreCloudUntil] = useState(0); // ★ 新增：暫停同步的冷卻時間
  const projectionRef = useRef(null);
  const bcRef = useRef(null);
  
  // --- 1. 初始化與雲端同步 (Poll Data) ---
  useEffect(() => {
    fetchCloudData();
    const interval = setInterval(() => {
      fetchCloudData();
    }, 2000); // 縮短為2秒更新一次，反應更快
    return () => clearInterval(interval);
  }, [ignoreCloudUntil]); // 加入依賴

  const fetchCloudData = async () => {
    // ★ 關鍵修正：如果還在冷卻時間內，完全不抓取雲端資料，避免閃爍
    if (Date.now() < ignoreCloudUntil) return;

    try {
      const res = await fetch(CLOUD_URL);
      if (!res.ok) return;
      const data = await res.json();
      
      if (data.ts && data.ts > lastTs) {
        // console.log("📥 同步雲端資料...");
        
        if (data.rounds) setRounds(data.rounds);
        if (data.currentRoundName) setCurrentRoundName(data.currentRoundName);
        if (data.currentMatches) setCurrentMatches(data.currentMatches);
        
        // 使用合併策略，防止資料丟失
        if (data.winnersMap) {
          setTableWinners((prev) => ({ ...prev, ...data.winnersMap }));
        }

        if (data.pageIndices) setPageIndices(data.pageIndices);
        if (typeof data.clockSeconds === 'number') {
           setClockSeconds(prev => Math.abs(prev - data.clockSeconds) > 3 ? data.clockSeconds : prev);
        }
        if (typeof data.timerRunning === 'boolean') setTimerRunning(data.timerRunning);

        setLastTs(data.ts);
      }
    } catch (e) {
      console.warn("Fetch error", e);
    }
  };

  // --- 2. 資料上傳 (Push Data) ---
  const saveDataToCloud = async (overrideState = {}) => {
    const newTs = Date.now();
    setLastTs(newTs);
    setIsSyncing(true);
    
    // ★ 關鍵修正：當我上傳資料時，設定 3 秒鐘的「冷卻時間」
    // 這 3 秒內，我的電腦會忽略所有雲端傳來的資料，這樣就不會被舊資料覆蓋而閃爍
    setIgnoreCloudUntil(Date.now() + 3000);

    const payload = {
      ts: newTs,
      rounds: overrideState.rounds || rounds,
      currentRoundName: overrideState.currentRoundName || currentRoundName,
      currentMatches: overrideState.currentMatches || currentMatches,
      winnersMap: overrideState.tableWinners || tableWinners,
      pageIndices: overrideState.pageIndices || pageIndices,
      clockSeconds: overrideState.clockSeconds ?? clockSeconds, 
      timerRunning: overrideState.timerRunning ?? timerRunning,
      
      // 投影參數
      pageIndex: (overrideState.pageIndices || pageIndices)[overrideState.currentRoundName || currentRoundName] || 0,
      pageSize: pageSizeForRound(overrideState.currentRoundName || currentRoundName),
      roundName: overrideState.currentRoundName || currentRoundName,
      type: "update"
    };

    broadcastToLocalProjection(payload);

    try {
      await fetch(CLOUD_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" }, 
        body: JSON.stringify(payload),
      });
    } catch (e) {
      console.error("Save failed", e);
    } finally {
      setIsSyncing(false);
    }
  };

  // --- 3. 投影通訊 ---
  const broadcastToLocalProjection = (payload) => {
    try { bcRef.current?.postMessage(payload); } catch {}
    try { projectionRef.current?.postMessage?.(payload, "*"); } catch {}
    try { projectionRef.current?.renderProjection?.(payload); } catch {}
  };

  useEffect(() => {
    try {
      bcRef.current = new BroadcastChannel("rummikub-bracket");
      bcRef.current.onmessage = (ev) => {
        if (ev.data?.type === "request_init") saveDataToCloud(); 
        if (ev.data?.type === "proj_page_prev") changePage(-1);
        if (ev.data?.type === "proj_page_next") changePage(1);
      };
    } catch { bcRef.current = null; }
    return () => bcRef.current?.close();
  }, [rounds, currentRoundName, tableWinners]); 

  // --- 4. 邏輯處理 ---
  useEffect(() => {
    if (!timerRunning) return;
    const t = setInterval(() => {
      setClockSeconds((s) => {
        if (s <= 1) {
          setTimerRunning(false);
          saveDataToCloud({ clockSeconds: 0, timerRunning: false });
          clearInterval(t);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [timerRunning]);

  const pageSizeForRound = (rName) => rName === "準決賽" ? 4 : 16;
  const changePage = (delta) => {
    const perPage = pageSizeForRound(currentRoundName);
    const maxPage = Math.max(0, Math.ceil((currentMatches?.length || 0) / perPage) - 1);
    const now = pageIndices[currentRoundName] || 0;
    const next = Math.max(0, Math.min(now + delta, maxPage));
    
    const newIndices = { ...pageIndices, [currentRoundName]: next };
    setPageIndices(newIndices);
    saveDataToCloud({ pageIndices: newIndices });
  };

  const markWinner = (tableId, player, idx) => {
    const key = `${currentRoundName}-${tableId}`;
    const newWinners = {
      ...tableWinners,
      [key]: { name: player, idx },
    };
    setTableWinners(newWinners);
    saveDataToCloud({ tableWinners: newWinners });
  };

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const XLSX = await import("https://cdn.sheetjs.com/xlsx-latest/package/xlsx.mjs");
    const data = await file.arrayBuffer();
    const workbook = XLSX.read(data);

    const newRounds = {};
    workbook.SheetNames.forEach((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      const json = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      const matches = json.slice(1).map((row, idx) => ({
          id: idx + 1,
          players: (row || []).map(c => c ? String(c).trim() : "").filter(t => t && !/^\d+$/.test(t) && !/初賽|複賽/.test(t)),
        })).filter((m) => m.players.length > 0);
      newRounds[sheetName] = matches;
    });

    const firstRound = (newRounds["初賽-1"] ? "初賽-1" : "") || Object.keys(newRounds)[0] || "";
    const newState = {
        rounds: newRounds,
        currentRoundName: firstRound,
        currentMatches: newRounds[firstRound] || [],
        tableWinners: {},
        pageIndices: {}
    };
    
    setRounds(newState.rounds);
    setCurrentRoundName(newState.currentRoundName);
    setCurrentMatches(newState.currentMatches);
    setTableWinners(newState.tableWinners);
    setPageIndices(newState.pageIndices);
    
    saveDataToCloud(newState);
  };

  const getNextRoundName = (current) => {
    if (current.includes("初賽")) return "複賽";
    if (current === "複賽") return "準決賽";
    if (current === "準決賽") return "決賽";
    return "比賽結束";
  };

  const advanceRound = () => {
    const nextRoundName = getNextRoundName(currentRoundName);
    if (nextRoundName === "比賽結束") return alert("已是決賽！");

    const allWinners = Object.entries(tableWinners);
    const currentWinners = allWinners
        .filter(([k]) => k.startsWith(currentRoundName.split('-')[0])) 
        .map(([, v]) => (typeof v === "string" ? v : v?.name));

    if (currentWinners.length === 0) return alert("⚠️ 請先標記勝者");

    const nextMatches = [];
    for (let i = 0; i < currentWinners.length; i += 4) {
        nextMatches.push({
            id: nextMatches.length + 1,
            players: currentWinners.slice(i, i + 4)
        });
    }

    const newRounds = { ...rounds, [nextRoundName]: nextMatches };
    const newState = {
        rounds: newRounds,
        currentRoundName: nextRoundName,
        currentMatches: nextMatches,
        pageIndices: {},
    };

    setRounds(newState.rounds);
    setCurrentRoundName(newState.currentRoundName);
    setCurrentMatches(newState.currentMatches);
    setPageIndices(newState.pageIndices);
    saveDataToCloud(newState);
  };
  
  const openProjectionWindow = () => {
    const w = window.open("projection.html", "rummikub-projection", "width=1280,height=720");
    projectionRef.current = w;
    setTimeout(() => saveDataToCloud(), 1000); 
  };

  const toggleTimer = () => {
      const newState = !timerRunning;
      setTimerRunning(newState);
      saveDataToCloud({ timerRunning: newState });
  };
  const resetTimer = () => {
      setTimerRunning(false);
      setClockSeconds(DEFAULT_MINUTES * 60);
      saveDataToCloud({ timerRunning: false, clockSeconds: DEFAULT_MINUTES * 60 });
  };

  /* ---------------- UI 渲染 ---------------- */
  return (
    <div style={{ padding: "10px 20px", fontFamily: "Arial", maxWidth: "1200px", margin: "0 auto" }}>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", marginBottom: 20, gap: 10 }}>
        <h2 style={{ margin: 0 }}>🏆 Rummikub 控制台</h2>
        <div style={{ fontSize: 12, color: isSyncing ? "orange" : "green" }}>
            {isSyncing ? "☁️ 同步中..." : "✅ 已同步"}
        </div>
      </div>

      <div style={{ background: "#f5f5f5", padding: 15, borderRadius: 12, marginBottom: 20 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 15, alignItems: "center" }}>
            <div>
                <input type="file" accept=".xlsx,.xls" onChange={handleFile} style={{ maxWidth: 200 }} />
                <button onClick={openProjectionWindow} style={btnStyle}>📺 投影畫面</button>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <strong>輪次:</strong>
                <select 
                    value={currentRoundName} 
                    onChange={(e) => {
                        const r = e.target.value;
                        setCurrentRoundName(r);
                        setCurrentMatches(rounds[r] || []);
                        saveDataToCloud({ currentRoundName: r, currentMatches: rounds[r] || [] });
                    }}
                    style={{ padding: 5, borderRadius: 5 }}
                >
                    {Object.keys(rounds).length === 0 && <option>請匯入檔案</option>}
                    {Object.keys(rounds).map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
            </div>

             <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <button onClick={toggleTimer} style={{...btnStyle, background: timerRunning ? "#ff6b6b" : "#51cf66"}}>
                    {timerRunning ? "暫停" : "計時"}
                </button>
                <button onClick={resetTimer} style={btnStyle}>重置</button>
                <span style={{ fontSize: 20, fontWeight: "bold", fontFamily: "monospace" }}>
                    {formatSeconds(clockSeconds)}
                </span>
            </div>
            
            <div style={{ marginLeft: "auto", display: "flex", gap: 5 }}>
                <button onClick={() => changePage(-1)} style={btnStyle}>⬅</button>
                <button onClick={() => changePage(1)} style={btnStyle}>➡</button>
            </div>
        </div>
      </div>

      <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: "15px",
      }}>
        {(currentMatches || []).map((m) => (
          <div key={m.id} style={{
              border: "1px solid #ddd", borderRadius: 12, padding: 15,
              background: "#fff", boxShadow: "0 2px 5px rgba(0,0,0,0.05)"
          }}>
            <div style={{ fontWeight: 900, marginBottom: 10, fontSize: 18, color: "#444" }}>
              第 {m.id} 桌
            </div>
            {(m.players || []).map((p, i) => {
              const w = tableWinners[`${currentRoundName}-${m.id}`];
              const isW = (w && w.name === p && w.idx === i) || w === p;
              return (
                <div key={p + i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <span style={{
                      width: 6, height: 30, borderRadius: 3,
                      background: COLORS[hashToIndex(p + i, COLORS.length)]
                  }} />
                  <span style={{ flex: 1, fontSize: 16, fontWeight: isW ? "bold" : "normal" }}>
                      {p}
                  </span>
                  
                  {isW ? (
                      <span style={{ color: "green", fontWeight: "bold" }}>🏆 晉級</span>
                  ) : (
                      <button 
                        onClick={() => markWinner(m.id, p, i)}
                        style={{ ...btnStyle, background: "#fff", border: "1px solid #ccc", color: "#333", padding: "4px 8px" }}
                      >
                        選取
                      </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div style={{ marginTop: 30, textAlign: "center" }}>
        <button onClick={advanceRound} style={{ ...btnStyle, padding: "10px 20px", fontSize: 16, background: "#339af0" }}>
          ⚡ 生成下一輪
        </button>
      </div>
    </div>
  );
}

const btnStyle = {
    cursor: "pointer",
    padding: "6px 12px",
    borderRadius: "6px",
    border: "none",
    background: "#333",
    color: "#fff",
    fontSize: "14px"
};