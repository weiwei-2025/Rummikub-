import React, { useEffect, useRef, useState } from "react";

// ★ 請在此填入新的 Apps Script URL
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
  const [lastTs, setLastTs] = useState(0); // 記錄最後一次資料的時間戳
  const [isSyncing, setIsSyncing] = useState(false);
  const projectionRef = useRef(null);
  const bcRef = useRef(null);
  
  // --- 1. 初始化與雲端同步 (Poll Data) ---
  useEffect(() => {
    // 啟動時先拉一次資料
    fetchCloudData();

    // 設定輪詢 (Polling)：每 3 秒檢查一次雲端有沒有別人更新的資料
    const interval = setInterval(() => {
      fetchCloudData();
    }, 3000);

    return () => clearInterval(interval);
  }, []); // 只在掛載時執行

  const fetchCloudData = async () => {
    try {
      const res = await fetch(CLOUD_URL);
      if (!res.ok) return;
      const data = await res.json();
      
      // 如果雲端資料比本地新 (ts 更大)，則更新本地畫面
      if (data.ts && data.ts > lastTs) {
        console.log("📥 檢測到雲端更新，同步中...");
        
        // 批次更新所有狀態
        if (data.rounds) setRounds(data.rounds);
        if (data.currentRoundName) setCurrentRoundName(data.currentRoundName);
        if (data.currentMatches) setCurrentMatches(data.currentMatches);
        if (data.winnersMap) setTableWinners(data.winnersMap);
        if (data.pageIndices) setPageIndices(data.pageIndices);
        
        // 計時器同步 (以防兩邊時間差太多)
        if (typeof data.clockSeconds === 'number') {
           // 只有當誤差超過 2 秒才校正，避免計時器一直跳動
           setClockSeconds(prev => Math.abs(prev - data.clockSeconds) > 2 ? data.clockSeconds : prev);
        }
        if (typeof data.timerRunning === 'boolean') setTimerRunning(data.timerRunning);

        setLastTs(data.ts);
      }
    } catch (e) {
      console.warn("Fetch error", e);
    }
  };

  // --- 2. 資料上傳 (Push Data) ---
  // 建立一個可以隨時呼叫的儲存函數，將當前所有狀態打包上傳
  const saveDataToCloud = async (overrideState = {}) => {
    const newTs = Date.now();
    setLastTs(newTs); // 更新本地時間戳
    setIsSyncing(true);

    // 組合當前狀態 (注意：React State 可能是舊的，如果是在 setState 後立刻呼叫，需傳入 overrideState)
    const payload = {
      ts: newTs,
      rounds: overrideState.rounds || rounds,
      currentRoundName: overrideState.currentRoundName || currentRoundName,
      currentMatches: overrideState.currentMatches || currentMatches,
      winnersMap: overrideState.tableWinners || tableWinners,
      pageIndices: overrideState.pageIndices || pageIndices,
      clockSeconds: overrideState.clockSeconds ?? clockSeconds, // 這裡用 ?? 允許 0
      timerRunning: overrideState.timerRunning ?? timerRunning,
      
      // 投影需要的額外資訊
      pageIndex: (overrideState.pageIndices || pageIndices)[overrideState.currentRoundName || currentRoundName] || 0,
      pageSize: pageSizeForRound(overrideState.currentRoundName || currentRoundName),
      roundName: overrideState.currentRoundName || currentRoundName,
      type: "update" // 給投影頁用的標記
    };

    // 1. 廣播給本地投影頁
    broadcastToLocalProjection(payload);

    // 2. 上傳至雲端
    try {
      await fetch(CLOUD_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" }, // 避免 CORS 預檢請求
        body: JSON.stringify(payload),
      });
    } catch (e) {
      console.error("Save failed", e);
    } finally {
      setIsSyncing(false);
    }
  };

  // --- 3. 投影通訊 (BroadcastChannel + Window) ---
  const broadcastToLocalProjection = (payload) => {
    try { bcRef.current?.postMessage(payload); } catch {}
    try { projectionRef.current?.postMessage?.(payload, "*"); } catch {}
    try { projectionRef.current?.renderProjection?.(payload); } catch {}
  };

  useEffect(() => {
    // 建立廣播頻道
    try {
      bcRef.current = new BroadcastChannel("rummikub-bracket");
      bcRef.current.onmessage = (ev) => {
        if (ev.data?.type === "request_init") saveDataToCloud(); // 投影頁要資料時，廣播目前狀態
        if (ev.data?.type === "proj_page_prev") changePage(-1);
        if (ev.data?.type === "proj_page_next") changePage(1);
      };
    } catch { bcRef.current = null; }

    return () => bcRef.current?.close();
  }, [rounds, currentRoundName, tableWinners]); // 依賴變數，確保閉包內數值正確

  // --- 4. 邏輯處理 ---
  
  // 計時器 Effect
  useEffect(() => {
    if (!timerRunning) return;
    const t = setInterval(() => {
      setClockSeconds((s) => {
        if (s <= 1) {
          setTimerRunning(false);
          // 倒數結束也要同步一次狀態
          saveDataToCloud({ clockSeconds: 0, timerRunning: false });
          clearInterval(t);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [timerRunning]);

  // 輔助：切換頁面
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

  // 動作：標記勝者 (核心同步點)
  const markWinner = (tableId, player, idx) => {
    const key = `${currentRoundName}-${tableId}`;
    const newWinners = {
      ...tableWinners,
      [key]: { name: player, idx },
    };
    setTableWinners(newWinners);
    // ★ 立即上傳雲端，讓其他人看到
    saveDataToCloud({ tableWinners: newWinners });
  };

  // 動作：匯入 Excel
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
    
    // 更新並上傳
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

  // 動作：下一輪
  const getNextRoundName = (current) => {
    if (current.includes("初賽")) return "複賽";
    if (current === "複賽") return "準決賽";
    if (current === "準決賽") return "決賽";
    return "比賽結束";
  };

  const advanceRound = () => {
    const nextRoundName = getNextRoundName(currentRoundName);
    if (nextRoundName === "比賽結束") return alert("已是決賽！");

    // 簡單的晉級邏輯
    const allWinners = Object.entries(tableWinners);
    // 過濾出屬於當前輪次的贏家
    const currentWinners = allWinners
        .filter(([k]) => k.startsWith(currentRoundName.split('-')[0])) // 簡單做：如果是初賽-1, 抓 "初賽" 開頭即可
        .map(([, v]) => (typeof v === "string" ? v : v?.name));

    if (currentWinners.length === 0) return alert("⚠️ 請先標記勝者");

    // 分組邏輯 (簡化版：每4人一組)
    const nextMatches = [];
    for (let i = 0; i < currentWinners.length; i += 4) {
        nextMatches.push({
            id: nextMatches.length + 1,
            players: currentWinners.slice(i, i + 4)
        });
    }

    const newRounds = { ...rounds, [nextRoundName]: nextMatches };
    
    // 更新並上傳
    const newState = {
        rounds: newRounds,
        currentRoundName: nextRoundName,
        currentMatches: nextMatches,
        pageIndices: {},
        // tableWinners 不清空嗎？通常晉級表單會保留歷史贏家，若要清空可在此加
    };

    setRounds(newState.rounds);
    setCurrentRoundName(newState.currentRoundName);
    setCurrentMatches(newState.currentMatches);
    setPageIndices(newState.pageIndices);
    
    saveDataToCloud(newState);
  };
  
  // 動作：開啟投影
  const openProjectionWindow = () => {
    const w = window.open("projection.html", "rummikub-projection", "width=1280,height=720");
    projectionRef.current = w;
    setTimeout(() => saveDataToCloud(), 1000); // 確保投影頁打開後收到資料
  };

  // 動作：計時器操作
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
      {/* Header */}
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", marginBottom: 20, gap: 10 }}>
        <h2 style={{ margin: 0 }}>🏆 Rummikub 控制台</h2>
        <div style={{ fontSize: 12, color: isSyncing ? "orange" : "green" }}>
            {isSyncing ? "☁️ 同步中..." : "✅ 已同步"}
        </div>
      </div>

      {/* 控制列 */}
      <div style={{ background: "#f5f5f5", padding: 15, borderRadius: 12, marginBottom: 20 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 15, alignItems: "center" }}>
            {/* 檔案與投影 */}
            <div>
                <input type="file" accept=".xlsx,.xls" onChange={handleFile} style={{ maxWidth: 200 }} />
                <button onClick={openProjectionWindow} style={btnStyle}>📺 投影畫面</button>
            </div>

            {/* 輪次選擇 */}
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

             {/* 計時器 */}
             <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <button onClick={toggleTimer} style={{...btnStyle, background: timerRunning ? "#ff6b6b" : "#51cf66"}}>
                    {timerRunning ? "暫停" : "計時"}
                </button>
                <button onClick={resetTimer} style={btnStyle}>重置</button>
                <span style={{ fontSize: 20, fontWeight: "bold", fontFamily: "monospace" }}>
                    {formatSeconds(clockSeconds)}
                </span>
            </div>
            
            {/* 換頁 */}
            <div style={{ marginLeft: "auto", display: "flex", gap: 5 }}>
                <button onClick={() => changePage(-1)} style={btnStyle}>⬅</button>
                <button onClick={() => changePage(1)} style={btnStyle}>➡</button>
            </div>
        </div>
      </div>

      {/* 比賽桌次卡片區 - 響應式 Grid */}
      <div style={{
          display: "grid",
          // ★ 關鍵修改：使用 auto-fit 實現 RWD，手機顯示 1 欄，電腦顯示多欄
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
