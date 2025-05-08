// popup.js

document.addEventListener("DOMContentLoaded", () => {
  const dailyTableBody = document.querySelector("#dailyTable tbody");
  const weeklyTableBody = document.querySelector("#weeklyTable tbody");
  const noDailyData = document.getElementById("noDailyData");
  const noWeeklyData = document.getElementById("noWeeklyData");
  const dailyReportTitle = document.getElementById("dailyReportTitle");
  const weeklyReportTitle = document.getElementById("weeklyReportTitle");
  const dailyChartContainer = document.getElementById("dailyChartContainer");
  const weeklyChartContainer = document.getElementById("weeklyChartContainer");
  let dailyChartInstance = null;
  let weeklyChartInstance = null;

  const todayBtn = document.getElementById("todayBtn");
  const thisWeekBtn = document.getElementById("thisWeekBtn");
  const prevDayBtn = document.getElementById("prevDayBtn");
  const nextDayBtn = document.getElementById("nextDayBtn");
  const prevWeekBtn = document.getElementById("prevWeekBtn");
  const nextWeekBtn = document.getElementById("nextWeekBtn");

  let currentDate = new Date(); // For daily navigation
  let currentWeekDate = new Date(); // For weekly navigation, represents a day within the target week

  function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function getWeekKey(date) {
    const year = date.getFullYear();
    const firstDayOfYear = new Date(year, 0, 1);
    const pastDaysOfYear = (date - firstDayOfYear) / 86400000;
    const weekNumber = Math.ceil(
      (pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7
    );
    return `${year}-W${String(weekNumber).padStart(2, "0")}`;
  }

  function displayData(
    tableBody,
    noDataElement,
    data,
    titleElement,
    titlePrefix,
    dateString,
    tabMeta
  ) {
    tableBody.innerHTML = ""; // Clear previous data
    titleElement.textContent = `${titlePrefix} (${dateString})`;

    if (data && Object.keys(data).length > 0) {
      noDataElement.style.display = "none";
      tableBody.parentElement.style.display = "table";
      const chartContainer =
        titlePrefix === "每日报告" ? dailyChartContainer : weeklyChartContainer;
      let chartInstance =
        titlePrefix === "每日报告" ? dailyChartInstance : weeklyChartInstance;

      if (chartInstance) {
        echarts.dispose(chartInstance);
        chartInstance = null;
        if (titlePrefix === "每日报告") dailyChartInstance = null;
        else weeklyChartInstance = null;
      }
      // Ensure container is visible before init, and other is hidden
      if (titlePrefix === "每日报告") {
        dailyChartContainer.style.display = "block";
        weeklyChartContainer.style.display = "none";
        if (weeklyChartInstance) echarts.dispose(weeklyChartInstance);
        weeklyChartInstance = null;
      } else {
        weeklyChartContainer.style.display = "block";
        dailyChartContainer.style.display = "none";
        if (dailyChartInstance) echarts.dispose(dailyChartInstance);
        dailyChartInstance = null;
      }

      // Sort data by duration (descending)
      const sortedData = Object.entries(data).sort(([, a], [, b]) => b - a);

      for (const [hostname, duration] of sortedData) {
        const row = tableBody.insertRow();
        const hostnameCell = row.insertCell();
        const titleCell = row.insertCell();
        const durationCell = row.insertCell();
        const meta =
          tabMeta && tabMeta[hostname]
            ? tabMeta[hostname]
            : { title: "", url: "" };
        const displayHostname =
          hostname.length > 50 ? hostname.substring(0, 47) + "..." : hostname;
        hostnameCell.textContent = displayHostname;
        hostnameCell.title = hostname;
        titleCell.textContent = meta.title || "";
        titleCell.title = meta.title || "";
        durationCell.textContent = formatDuration(duration);
      }

      const chartData = sortedData.map((item) => ({
        name: item[0],
        value: item[1],
      }));

      if (titlePrefix === "每日报告") {
        dailyChartInstance = echarts.init(chartContainer);
        const dailyOption = {
          tooltip: {
            trigger: "item",
            formatter: function (params) {
              const percentage = params.percent;
              return `${params.name}: ${formatDuration(
                params.value
              )} (${percentage}%)`;
            },
          },
          legend: {
            top: "5%",
            left: "center",
            // selectedMode: false, // Optional: if you don't want legend items to be clickable for filtering
          },
          series: [
            {
              name: "时间占比",
              type: "pie",
              radius: ["40%", "70%"],
              avoidLabelOverlap: false,
              itemStyle: {
                borderRadius: 10,
                borderColor: "#fff",
                borderWidth: 2,
              },
              label: {
                show: false,
                position: "center",
              },
              emphasis: {
                label: {
                  show: true,
                  fontSize: "16",
                  fontWeight: "bold",
                },
              },
              labelLine: {
                show: false,
              },
              data: chartData,
            },
          ],
        };
        dailyChartInstance.setOption(dailyOption);
      } else if (titlePrefix === "每周报告") {
        weeklyChartInstance = echarts.init(chartContainer);
        const weeklyOption = {
          tooltip: {
            trigger: "item",
            formatter: function (params) {
              if (params.value) {
                return `${params.name}: ${formatDuration(params.value)}`;
              }
              return "";
            },
          },
          series: [
            {
              type: "treemap",
              name: "每周浏览时长",
              data: chartData.map((item) => ({
                name: item.name,
                value: item.value,
                children: null,
              })), // Echarts treemap needs children or value
              leafDepth: 1, // Only show top level
              levels: [
                {
                  itemStyle: {
                    borderColor: "#fff",
                    borderWidth: 1,
                    gapWidth: 1,
                  },
                  upperLabel: {
                    show: false,
                  },
                },
                {
                  itemStyle: {
                    borderColor: "#555",
                    borderWidth: 2,
                    gapWidth: 1,
                  },
                  emphasis: {
                    itemStyle: {
                      borderColor: "#ddd",
                    },
                  },
                },
              ],
              label: {
                show: true,
                formatter: function (params) {
                  return params.name + "\n" + formatDuration(params.value);
                },
                fontSize: 10,
              },
              breadcrumb: { show: false }, // Hide breadcrumb navigation for simple treemap
            },
          ],
        };
        weeklyChartInstance.setOption(weeklyOption);
      }
    } else {
      noDataElement.style.display = "block";
      tableBody.parentElement.style.display = "none";
      const chartContainer =
        titlePrefix === "每日报告" ? dailyChartContainer : weeklyChartContainer;
      let chartInstance =
        titlePrefix === "每日报告" ? dailyChartInstance : weeklyChartInstance;
      if (chartInstance) {
        echarts.dispose(chartInstance);
        if (titlePrefix === "每日报告") dailyChartInstance = null;
        else weeklyChartInstance = null;
      }
      chartContainer.style.display = "none";
    }
  }

  function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    let formatted = "";
    if (h > 0) formatted += `${h}时`;
    if (m > 0) formatted += `${m}分`;
    if (s > 0 || (h === 0 && m === 0)) formatted += `${s}秒`;
    return formatted || "0秒";
  }

  function loadDailyReport(date) {
    const dateKey = formatDate(date);
    chrome.storage.local.get(["dailyStats", "tabMeta"], (result) => {
      const dailyStats = result.dailyStats || {};
      const tabMeta = result.tabMeta || {};
      displayData(
        dailyTableBody,
        noDailyData,
        dailyStats[dateKey],
        dailyReportTitle,
        "每日报告",
        dateKey,
        tabMeta
      );
    });
  }

  function loadWeeklyReport(dateInWeek) {
    const weekKey = getWeekKey(dateInWeek);
    chrome.storage.local.get(["weeklyStats", "tabMeta"], (result) => {
      const weeklyStats = result.weeklyStats || {};
      const tabMeta = result.tabMeta || {};
      displayData(
        weeklyTableBody,
        noWeeklyData,
        weeklyStats[weekKey],
        weeklyReportTitle,
        "每周报告",
        weekKey,
        tabMeta
      );
    });
  }

  // Initial load
  loadDailyReport(currentDate);
  loadWeeklyReport(currentWeekDate);
  document.getElementById("weeklyReport").style.display = "none"; // Hide weekly by default
  weeklyChartContainer.style.display = "none"; // Hide weekly chart by default

  // Event Listeners
  todayBtn.addEventListener("click", () => {
    currentDate = new Date();
    loadDailyReport(currentDate);
    document.getElementById("dailyReport").style.display = "block";
    document.getElementById("weeklyReport").style.display = "none";
  });

  thisWeekBtn.addEventListener("click", () => {
    currentWeekDate = new Date();
    loadWeeklyReport(currentWeekDate);
    document.getElementById("dailyReport").style.display = "none";
    document.getElementById("weeklyReport").style.display = "block";
  });

  prevDayBtn.addEventListener("click", () => {
    currentDate.setDate(currentDate.getDate() - 1);
    loadDailyReport(currentDate);
    document.getElementById("dailyReport").style.display = "block";
    document.getElementById("weeklyReport").style.display = "none";
  });

  nextDayBtn.addEventListener("click", () => {
    currentDate.setDate(currentDate.getDate() + 1);
    // Prevent going into the future beyond today for daily reports
    if (currentDate > new Date()) {
      currentDate.setDate(currentDate.getDate() - 1); // Revert to today
      alert("不能查看未来的日期。");
      return;
    }
    loadDailyReport(currentDate);
    document.getElementById("dailyReport").style.display = "block";
    document.getElementById("weeklyReport").style.display = "none";
  });

  prevWeekBtn.addEventListener("click", () => {
    currentWeekDate.setDate(currentWeekDate.getDate() - 7);
    loadWeeklyReport(currentWeekDate);
    document.getElementById("dailyReport").style.display = "none";
    document.getElementById("weeklyReport").style.display = "block";
  });

  nextWeekBtn.addEventListener("click", () => {
    const tempNextWeek = new Date(currentWeekDate);
    tempNextWeek.setDate(tempNextWeek.getDate() + 7);
    // Prevent going into future weeks
    if (getWeekKey(tempNextWeek) > getWeekKey(new Date())) {
      alert("不能查看未来的周报。");
      return;
    }
    currentWeekDate.setDate(currentWeekDate.getDate() + 7);
    loadWeeklyReport(currentWeekDate);
    document.getElementById("dailyReport").style.display = "none";
    document.getElementById("weeklyReport").style.display = "block";
  });

  // 修改 loadDailyReport 以便切换时刷新日期选择器
  const originalLoadDailyReport = loadDailyReport;
  loadDailyReport = function (date) {
    originalLoadDailyReport(date);
  };

});
