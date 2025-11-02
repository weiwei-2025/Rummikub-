import React, { useEffect, useRef, useState } from "react";

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
  "#ffd873",
  "#c6e9ff",
  "#ffe0f0",
  "#e6ffd9",
  "#f0e6ff",
  "#ffdede",
  "#e8f5ff",
  "#fff4d6",
  "#e6ffe7",
  "#f6e8ff",
];

/* ---------------- 主控畫面 ---------------- */
export default function App() {
  // 輪次 → [{id, players: string[]}]
  const [rounds, setRounds] = useState({});
  const [currentRoundName, setCurrentRoundName] = useState("");
  const [currentMatches, setCurrentMatches] = useState([]);

  // 各輪的投影分頁 index
  const [pageIndices, setPageIndices] = useState({});
  // 勝者紀錄： `${round}-${tableId}` : player
  const [tableWinners, setTableWinners] = useState({});

  // 計時器
  const DEFAULT_MINUTES = 20;
  const [clockSeconds, setClockSeconds] = useState(DEFAULT_MINUTES * 60);
  const [timerRunning, setTimerRunning] = useState(false);

  // 通訊
  const projectionRef = useRef(null);
  const bcRef = useRef(null);

  /* ---------- 分頁 ---------- */
  const pageSizeForRound = (roundName) =>
    roundName === "準決賽" ? 4 : 16;

  const setPageIndexForRound = (roundName, idx) =>
    setPageIndices((prev) => ({
      ...prev,
      [roundName]: Math.max(0, idx),
    }));

  const nextPage = () => {
    const perPage = pageSizeForRound(currentRoundName);
    const maxPage = Math.max(
      0,
      Math.ceil((currentMatches?.length || 0) / perPage) - 1
    );
    const now = pageIndices[currentRoundName] || 0;
    setPageIndexForRound(currentRoundName, Math.min(now + 1, maxPage));
  };

  const prevPage = () => {
    const now = pageIndices[currentRoundName] || 0;
    setPageIndexForRound(currentRoundName, Math.max(now - 1, 0));
  };

  /* ---------- 建立 BroadcastChannel 與投影翻頁監聽 ---------- */
  useEffect(() => {
    try {
      bcRef.current = new BroadcastChannel("rummikub-bracket");
      bcRef.current.onmessage = (ev) => {
        if (!ev?.data) return;
        if (ev.data.type === "request_init") broadcastState();
        if (ev.data.type === "proj_page_prev") prevPage();
        if (ev.data.type === "proj_page_next") nextPage();
      };
    } catch {
      bcRef.current = null;
    }

    const onMsg = (ev) => {
      if (!ev?.data) return;
      if (ev.data.type === "request_init") broadcastState();
      if (ev.data.type === "proj_page_prev") prevPage();
      if (ev.data.type === "proj_page_next") nextPage();
    };
    window.addEventListener("message", onMsg);

    const onStorage = (e) => {
      if (e.key !== "rummi_page_event" || !e.newValue) return;
      try {
        const data = JSON.parse(e.newValue);
        if (data?.type === "proj_page_prev") prevPage();
        if (data?.type === "proj_page_next") nextPage();
        if (data?.type === "request_init") broadcastState();
      } catch {}
    };
    window.addEventListener("storage", onStorage);

    return () => {
      window.removeEventListener("message", onMsg);
      window.removeEventListener("storage", onStorage);
      if (bcRef.current) bcRef.current.close();
      if (projectionRef.current && !projectionRef.current.closed)
        projectionRef.current.close();
    };
  }, []);

  /* ---------- 計時器 ---------- */
  useEffect(() => {
    if (!timerRunning) return;
    const t = setInterval(() => {
      setClockSeconds((s) => {
        if (s <= 1) {
          setTimerRunning(false);
          clearInterval(t);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [timerRunning]);

  /* ---------- 狀態異動就廣播到投影 ---------- */
  useEffect(() => {
    broadcastState();
  }, [
    tableWinners,
    pageIndices,
    clockSeconds,
    timerRunning,
    currentRoundName,
    currentMatches,
  ]);

  /* ---------- 廣播到投影視窗（BC + postMessage） ---------- */
  const broadcastState = () => {
    const perPage = pageSizeForRound(currentRoundName);
    const pageIndex = pageIndices[currentRoundName] || 0;

    const payload = {
      type: "update",
      winnersMap: tableWinners,
      pageIndices,
      pageIndex,
      pageSize: perPage,
      clockSeconds,
      timerRunning,
      roundName: currentRoundName,
      currentMatches,
    };

    try {
      bcRef.current?.postMessage(payload);
    } catch {}
    try {
      projectionRef.current?.postMessage?.(payload, "*");
    } catch {}
    try {
      projectionRef.current?.renderProjection?.(payload);
    } catch {}
  };

/* ---------- 開啟投影視窗（載入 projection.html） ---------- */
const openProjectionWindow = () => {
  if (projectionRef.current && !projectionRef.current.closed) {
    projectionRef.current.focus();
    broadcastState(); // 確保資料即時更新
    return;
  }

  // ✅ 直接打開 public/projection.html（或根目錄同層）
  const w = window.open("projection.html", "rummikub-projection", "width=1280,height=720");
  projectionRef.current = w;

  // 等投影頁載入完成後再傳送目前狀態
  setTimeout(() => broadcastState(), 1000);
};


  /* ---------- 匯入 Excel ---------- */
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

      const matches = json
        .slice(1)
        .map((row, idx) => ({
          id: idx + 1,
          players: (row || [])
            .map((cell) =>
              cell == null ? "" : String(cell).trim()
            )
            .filter(
              (txt) =>
                txt.length > 0 &&
                !/^\d+$/.test(txt) &&
                !/初賽|複賽|準決賽|決賽/.test(txt)
            ),
        }))
        .filter((m) => m.players.length > 0);

      newRounds[sheetName] = matches;
    });

    const firstRound =
      (newRounds["初賽-1"] ? "初賽-1" : "") ||
      Object.keys(newRounds)[0] ||
      "";

    setRounds(newRounds);
    setCurrentRoundName(firstRound);
    setCurrentMatches(newRounds[firstRound] || []);
    setPageIndices({});
    setTableWinners({});
  };

  /* ---------- 勝者點選 ---------- */
  const markWinner = (tableId, player, idx) => {
    setTableWinners((prev) => ({
      ...prev,
         // 存成物件，同時記名字與同桌內的位置
         [`${currentRoundName}-${tableId}`]: { name: player, idx },
        }));
      };

  /* ---------- 下一輪 ---------- */
  const getNextRoundName = (current) => {
    if (current.includes("初賽")) return "複賽";
    if (current === "複賽") return "準決賽";
    if (current === "準決賽") return "決賽";
    return "比賽結束";
  };

  const advanceRound = () => {
    const current = currentRoundName;
    const nextRoundName = getNextRoundName(current);
    const allWinners = Object.entries(tableWinners);

    if (nextRoundName === "複賽") {
      console.log("📊 allWinners", allWinners);
      const buckets = {};
      const push = (deskId, name) => {
        if (!name) return;
        if (!buckets[deskId]) buckets[deskId] = [];
        if (buckets[deskId].length < 4) buckets[deskId].push(name);
      };

      allWinners.forEach(([key, v]) => {
        const name = (typeof v === "string" ? v : v?.name);
        const m1 = key.match(/^初賽-1-(\d+)$/);
        if (m1) {
          const t = Number(m1[1]);
          const deskId = 1 + Math.floor((t - 1) / 4);
          push(deskId, name);
        }
      });
      allWinners.forEach(([key, v]) => {
        const name = (typeof v === "string" ? v : v?.name);
        const m2 = key.match(/^初賽-2-(\d+)$/);
        if (m2) {
          const t = Number(m2[1]);
          const deskId = 9 + Math.floor((t - 1) / 4);
          push(deskId, name);
        }
      });

      const nextMatches = Array.from({ length: 16 }, (_, i) => ({
        id: i + 1,
        players: buckets[i + 1] || [],
      }));

      const hasAny = nextMatches.some((m) => m.players.length > 0);
      if (!hasAny) return alert("⚠️ 請先標記勝者");

      setRounds((prev) => ({ ...prev, [nextRoundName]: nextMatches }));
      setCurrentRoundName(nextRoundName);
      setCurrentMatches(nextMatches);
      setPageIndices({});
      return;
    }

    if (nextRoundName === "準決賽") {
      const winners = allWinners
        .filter(([key]) => key.startsWith(`${current}-`))
        .map(([, val]) => (typeof val === "string" ? val : val?.name));
      if (!winners.length) return alert("⚠️ 請先標記勝者");

      const buckets = { 1: [], 2: [], 3: [], 4: [] };
      for (let i = 0; i < winners.length; i++) {
        const g = 1 + Math.floor(i / 4);
        if (buckets[g] && buckets[g].length < 4)
          buckets[g].push(winners[i]);
      }
      const nextMatches = Object.keys(buckets).map((k) => ({
        id: Number(k),
        players: buckets[k],
      }));

      setRounds((prev) => ({ ...prev, [nextRoundName]: nextMatches }));
      setCurrentRoundName(nextRoundName);
      setCurrentMatches(nextMatches);
      setPageIndices({});
      return;
    }

    if (nextRoundName === "決賽") {
      const winners = allWinners
        .filter(([key]) => key.startsWith(`${current}-`))
        .map(([, val]) => (typeof val === "string" ? val : val?.name));
      if (!winners.length) return alert("⚠️ 請先標記勝者");

      const nextMatches = [{ id: 1, players: winners.slice(0, 4) }];
      setRounds((prev) => ({ ...prev, [nextRoundName]: nextMatches }));
      setCurrentRoundName(nextRoundName);
      setCurrentMatches(nextMatches);
      setPageIndices({});
      return;
    }

    alert("🏁 已是決賽！");
  };

  /* ---------- 控制台 ---------- */
  return (
    <div style={{ padding: 20, fontFamily: "Arial" }}>
      <h2>Rummikub 投影管理</h2>
      <div style={{ marginBottom: 12 }}>
        <input type="file" accept=".xlsx,.xls" onChange={handleFile} />
        <button onClick={openProjectionWindow} style={{ marginLeft: 8 }}>
          開啟投影畫面
        </button>
      </div>

      <div
        style={{
          marginBottom: 12,
          display: "flex",
          gap: 12,
          alignItems: "center",
        }}
      >
        <div>
          <strong>當前輪次：</strong>
          <select
            value={currentRoundName}
            onChange={(e) => {
              const r = e.target.value;
              setCurrentRoundName(r);
              setCurrentMatches(rounds[r] || []);
            }}
          >
            {Object.keys(rounds).map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={() => setTimerRunning(!timerRunning)}>
            {timerRunning ? "暫停計時" : "開始計時"}
          </button>
          <button
            onClick={() => {
              setTimerRunning(false);
              setClockSeconds(DEFAULT_MINUTES * 60);
            }}
          >
            重新計時
          </button>
          <span style={{ marginLeft: 8, fontSize: 18 }}>
            {formatSeconds(clockSeconds)}
          </span>
        </div>

        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button onClick={prevPage}>⬅ 上一頁</button>
          <button onClick={nextPage}>下一頁 ➡</button>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: "12px",
        }}
      >
        {(currentMatches || []).map((m) => (
          <div
            key={m.id}
            style={{
              border: "2px solid #ddd",
              borderRadius: 12,
              padding: 10,
              background: "#fff",
            }}
          >
            <div style={{ fontWeight: 900, marginBottom: 6 }}>
              第{m.id}桌
            </div>
            {(m.players || []).map((p, i) => {
              const w = tableWinners[`${currentRoundName}-${m.id}`];
              const isW = (w && w.name === p && w.idx === i) || w === p; // 後面那段為了相容舊資料
              return (
                <div
                  key={p + i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    marginTop: 4,
                  }}
                >
                  <span
                    style={{
                      display: "inline-block",
                      width: 6,
                      height: 18,
                      background: COLORS[hashToIndex(p + i, COLORS.length)],
                      borderRadius: 3,
                    }}
                  />
                  <span style={{ flex: 1 }}>{p}</span>
                  <button onClick={() => markWinner(m.id, p, i)}>勝者</button>
                  {isW && <span>✅</span>}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div style={{ marginTop: 18 }}>
        <button
          onClick={advanceRound}
          style={{ padding: "6px 12px", fontWeight: 700 }}
        >
          生成下一輪（自動命名）
        </button>
      </div>
    </div>
  );
}
