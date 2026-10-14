// Ethiopian Fertilizer Supply Chain Management Information System (EFMIS)
// Master Data for Daily Fertilizer Summary Report & Regional Vessel Dispatch Report

export const DAILY_SUMMARY_DATES: any = [
  { id: '25.03.2016', label: '25.03.2016 (ህዳር 25)', isLatest: false },
  { id: '26.03.2016', label: '26.03.2016 (ህዳር 26)', isLatest: false },
  { id: '27.03.2016', label: '27.03.2016 (ህዳር 27)', isLatest: false },
  { id: '28.03.2016', label: '28.03.2016 (ህዳር 28)', isLatest: false },
  { id: '29.03.2016', label: '29.03.2016 (ህዳር 29)', isLatest: false },
  { id: '30.03.2016', label: '30.03.2016 (ህዳር 30)', isLatest: false },
  { id: '01.04.2016', label: '01.04.2016 (ታህሳስ 01)', isLatest: false },
  { id: '02.04.2016', label: '02.04.2016 (ታህሳስ 02)', isLatest: false },
  { id: '03.04.2016', label: '03.04.2016 (ታህሳስ 03)', isLatest: true }
];

export const INITIAL_DAILY_SUMMARY_RECORDS: any = {
  '03.04.2016': [
    {
      regionId: 'oromia',
      regionName: 'ኦሮሚያ (Oromia)',
      fertilizerType: 'UREA',
      procuredMT: 336638.00,
      regionalStockMT: 12085.00,
      dispatchedMT: 304631.00,
      portCumulativeMT: 77185.90,
      portDailyMT: 77185.90,
      currentRegionStockMT: 239530.10,
      deliveredToRegionMT: 77185.90,
      queueMT: 0,
      hubThisWeekMT: 4500.00,
      hubCumulativeMT: 28500.00
    },
    {
      regionId: 'oromia',
      regionName: 'ኦሮሚያ (Oromia)',
      fertilizerType: 'NPS',
      procuredMT: 180582.80,
      regionalStockMT: 1574.00,
      dispatchedMT: 164859.00,
      portCumulativeMT: 0,
      portDailyMT: 0,
      currentRegionStockMT: 166433.00,
      deliveredToRegionMT: 0,
      queueMT: 0,
      hubThisWeekMT: 0,
      hubCumulativeMT: 12400.00
    },
    {
      regionId: 'oromia',
      regionName: 'ኦሮሚያ (Oromia)',
      fertilizerType: 'NPSB',
      procuredMT: 407200.20,
      regionalStockMT: 3224.00,
      dispatchedMT: 360230.00,
      portCumulativeMT: 217.50,
      portDailyMT: 217.50,
      currentRegionStockMT: 363454.00,
      deliveredToRegionMT: 217.50,
      queueMT: 0,
      hubThisWeekMT: 3200.00,
      hubCumulativeMT: 41800.00
    },
    {
      regionId: 'oromia',
      regionName: 'ኦሮሚያ (Oromia)',
      fertilizerType: 'NPSZN',
      procuredMT: 0,
      regionalStockMT: 0,
      dispatchedMT: 0,
      portCumulativeMT: 0,
      portDailyMT: 0,
      currentRegionStockMT: 0,
      deliveredToRegionMT: 0,
      queueMT: 0,
      hubThisWeekMT: 0,
      hubCumulativeMT: 0
    },
    {
      regionId: 'oromia',
      regionName: 'ኦሮሚያ (Oromia)',
      fertilizerType: 'NPSZnB',
      procuredMT: 0,
      regionalStockMT: 0,
      dispatchedMT: 0,
      portCumulativeMT: 0,
      portDailyMT: 0,
      currentRegionStockMT: 0,
      deliveredToRegionMT: 0,
      queueMT: 0,
      hubThisWeekMT: 0,
      hubCumulativeMT: 0
    },
    {
      regionId: 'oromia',
      regionName: 'ኦሮሚያ (Oromia)',
      fertilizerType: 'DAP',
      procuredMT: 0,
      regionalStockMT: 0,
      dispatchedMT: 0,
      portCumulativeMT: 0,
      portDailyMT: 0,
      currentRegionStockMT: 0,
      deliveredToRegionMT: 0,
      queueMT: 0,
      hubThisWeekMT: 0,
      hubCumulativeMT: 0
    },
    {
      regionId: 'oromia',
      regionName: 'ኦሮሚያ (Oromia)',
      fertilizerType: 'KCL',
      procuredMT: 0,
      regionalStockMT: 0,
      dispatchedMT: 0,
      portCumulativeMT: 0,
      portDailyMT: 0,
      currentRegionStockMT: 0,
      deliveredToRegionMT: 0,
      queueMT: 0,
      hubThisWeekMT: 0,
      hubCumulativeMT: 0
    },

    // Amhara Region
    {
      regionId: 'amhara',
      regionName: 'አማራ (Amhara)',
      fertilizerType: 'UREA',
      procuredMT: 426848.00,
      regionalStockMT: 0,
      dispatchedMT: 375498.00,
      portCumulativeMT: 33203.40,
      portDailyMT: 33203.40,
      currentRegionStockMT: 375498.00,
      deliveredToRegionMT: 33203.40,
      queueMT: 0,
      hubThisWeekMT: 5100.00,
      hubCumulativeMT: 31200.00
    },
    {
      regionId: 'amhara',
      regionName: 'አማራ (Amhara)',
      fertilizerType: 'NPS',
      procuredMT: 8193.00,
      regionalStockMT: 0,
      dispatchedMT: 7208.00,
      portCumulativeMT: 0,
      portDailyMT: 0,
      currentRegionStockMT: 7208.00,
      deliveredToRegionMT: 0,
      queueMT: 0,
      hubThisWeekMT: 0,
      hubCumulativeMT: 1500.00
    },
    {
      regionId: 'amhara',
      regionName: 'አማራ (Amhara)',
      fertilizerType: 'NPSB',
      procuredMT: 485924.00,
      regionalStockMT: 0,
      dispatchedMT: 423084.00,
      portCumulativeMT: 1214.00,
      portDailyMT: 1214.00,
      currentRegionStockMT: 423084.00,
      deliveredToRegionMT: 1214.00,
      queueMT: 0,
      hubThisWeekMT: 2800.00,
      hubCumulativeMT: 38400.00
    },
    {
      regionId: 'amhara',
      regionName: 'አማራ (Amhara)',
      fertilizerType: 'NPSZN',
      procuredMT: 0,
      regionalStockMT: 0,
      dispatchedMT: 0,
      portCumulativeMT: 0,
      portDailyMT: 0,
      currentRegionStockMT: 0,
      deliveredToRegionMT: 0,
      queueMT: 0,
      hubThisWeekMT: 0,
      hubCumulativeMT: 0
    },
    {
      regionId: 'amhara',
      regionName: 'አማራ (Amhara)',
      fertilizerType: 'NPSZnB',
      procuredMT: 0,
      regionalStockMT: 0,
      dispatchedMT: 0,
      portCumulativeMT: 0,
      portDailyMT: 0,
      currentRegionStockMT: 0,
      deliveredToRegionMT: 0,
      queueMT: 0,
      hubThisWeekMT: 0,
      hubCumulativeMT: 0
    },
    {
      regionId: 'amhara',
      regionName: 'አማራ (Amhara)',
      fertilizerType: 'DAP',
      procuredMT: 0,
      regionalStockMT: 0,
      dispatchedMT: 0,
      portCumulativeMT: 0,
      portDailyMT: 0,
      currentRegionStockMT: 0,
      deliveredToRegionMT: 0,
      queueMT: 0,
      hubThisWeekMT: 0,
      hubCumulativeMT: 0
    },
    {
      regionId: 'amhara',
      regionName: 'አማራ (Amhara)',
      fertilizerType: 'KCL',
      procuredMT: 0,
      regionalStockMT: 0,
      dispatchedMT: 0,
      portCumulativeMT: 0,
      portDailyMT: 0,
      currentRegionStockMT: 0,
      deliveredToRegionMT: 0,
      queueMT: 0,
      hubThisWeekMT: 0,
      hubCumulativeMT: 0
    },

    // South Ethiopia Region
    {
      regionId: 'southEthiopia',
      regionName: 'ደቡብ ኢትዮጵያ (South Ethiopia)',
      fertilizerType: 'UREA',
      procuredMT: 25686.49,
      regionalStockMT: 330.40,
      dispatchedMT: 20596.00,
      portCumulativeMT: 3522.65,
      portDailyMT: 3522.65,
      currentRegionStockMT: 17403.75,
      deliveredToRegionMT: 3522.65,
      queueMT: 0,
      hubThisWeekMT: 850.00,
      hubCumulativeMT: 4200.00
    },
    {
      regionId: 'southEthiopia',
      regionName: 'ደቡብ ኢትዮጵያ (South Ethiopia)',
      fertilizerType: 'NPS',
      procuredMT: 5579.39,
      regionalStockMT: 8.10,
      dispatchedMT: 4908.00,
      portCumulativeMT: 0,
      portDailyMT: 0,
      currentRegionStockMT: 4916.10,
      deliveredToRegionMT: 0,
      queueMT: 0,
      hubThisWeekMT: 0,
      hubCumulativeMT: 800.00
    },
    {
      regionId: 'southEthiopia',
      regionName: 'ደቡብ ኢትዮጵያ (South Ethiopia)',
      fertilizerType: 'NPSB',
      procuredMT: 21237.06,
      regionalStockMT: 403.00,
      dispatchedMT: 14682.00,
      portCumulativeMT: 87.00,
      portDailyMT: 87.00,
      currentRegionStockMT: 14998.00,
      deliveredToRegionMT: 87.00,
      queueMT: 0,
      hubThisWeekMT: 420.00,
      hubCumulativeMT: 3100.00
    },
    {
      regionId: 'southEthiopia',
      regionName: 'ደቡብ ኢትዮጵያ (South Ethiopia)',
      fertilizerType: 'NPSZN',
      procuredMT: 0,
      regionalStockMT: 0,
      dispatchedMT: 0,
      portCumulativeMT: 0,
      portDailyMT: 0,
      currentRegionStockMT: 0,
      deliveredToRegionMT: 0,
      queueMT: 0,
      hubThisWeekMT: 0,
      hubCumulativeMT: 0
    },
    {
      regionId: 'southEthiopia',
      regionName: 'ደቡብ ኢትዮጵያ (South Ethiopia)',
      fertilizerType: 'NPSZnB',
      procuredMT: 0,
      regionalStockMT: 0,
      dispatchedMT: 0,
      portCumulativeMT: 0,
      portDailyMT: 0,
      currentRegionStockMT: 0,
      deliveredToRegionMT: 0,
      queueMT: 0,
      hubThisWeekMT: 0,
      hubCumulativeMT: 0
    },
    {
      regionId: 'southEthiopia',
      regionName: 'ደቡብ ኢትዮጵያ (South Ethiopia)',
      fertilizerType: 'DAP',
      procuredMT: 0,
      regionalStockMT: 0,
      dispatchedMT: 0,
      portCumulativeMT: 0,
      portDailyMT: 0,
      currentRegionStockMT: 0,
      deliveredToRegionMT: 0,
      queueMT: 0,
      hubThisWeekMT: 0,
      hubCumulativeMT: 0
    },

    // Sidama Region
    {
      regionId: 'sidama',
      regionName: 'ሲዳማ (Sidama)',
      fertilizerType: 'UREA',
      procuredMT: 18450.00,
      regionalStockMT: 210.00,
      dispatchedMT: 16200.00,
      portCumulativeMT: 2840.00,
      portDailyMT: 2840.00,
      currentRegionStockMT: 13570.00,
      deliveredToRegionMT: 2840.00,
      queueMT: 0,
      hubThisWeekMT: 600.00,
      hubCumulativeMT: 3400.00
    },
    {
      regionId: 'sidama',
      regionName: 'ሲዳማ (Sidama)',
      fertilizerType: 'NPSB',
      procuredMT: 24100.00,
      regionalStockMT: 180.00,
      dispatchedMT: 21300.00,
      portCumulativeMT: 140.00,
      portDailyMT: 140.00,
      currentRegionStockMT: 21340.00,
      deliveredToRegionMT: 140.00,
      queueMT: 0,
      hubThisWeekMT: 450.00,
      hubCumulativeMT: 2900.00
    },

    // Central Ethiopia Region
    {
      regionId: 'centralEthiopia',
      regionName: 'ማዕከላዊ ኢትዮጵያ (Central Ethiopia)',
      fertilizerType: 'UREA',
      procuredMT: 31200.00,
      regionalStockMT: 450.00,
      dispatchedMT: 27800.00,
      portCumulativeMT: 4120.00,
      portDailyMT: 4120.00,
      currentRegionStockMT: 24130.00,
      deliveredToRegionMT: 4120.00,
      queueMT: 0,
      hubThisWeekMT: 950.00,
      hubCumulativeMT: 5200.00
    },
    {
      regionId: 'centralEthiopia',
      regionName: 'ማዕከላዊ ኢትዮጵያ (Central Ethiopia)',
      fertilizerType: 'NPSB',
      procuredMT: 38400.00,
      regionalStockMT: 320.00,
      dispatchedMT: 34100.00,
      portCumulativeMT: 310.00,
      portDailyMT: 310.00,
      currentRegionStockMT: 34110.00,
      deliveredToRegionMT: 310.00,
      queueMT: 0,
      hubThisWeekMT: 720.00,
      hubCumulativeMT: 4800.00
    },

    // Tigray Region
    {
      regionId: 'tigray',
      regionName: 'ትግራይ (Tigray)',
      fertilizerType: 'UREA',
      procuredMT: 45000.00,
      regionalStockMT: 0,
      dispatchedMT: 38000.00,
      portCumulativeMT: 5200.00,
      portDailyMT: 5200.00,
      currentRegionStockMT: 32800.00,
      deliveredToRegionMT: 5200.00,
      queueMT: 0,
      hubThisWeekMT: 1200.00,
      hubCumulativeMT: 6400.00
    },
    {
      regionId: 'tigray',
      regionName: 'ትግራይ (Tigray)',
      fertilizerType: 'NPSB',
      procuredMT: 52000.00,
      regionalStockMT: 0,
      dispatchedMT: 44000.00,
      portCumulativeMT: 480.00,
      portDailyMT: 480.00,
      currentRegionStockMT: 43520.00,
      deliveredToRegionMT: 480.00,
      queueMT: 0,
      hubThisWeekMT: 980.00,
      hubCumulativeMT: 5800.00
    },

    // Benishangul-Gumuz
    {
      regionId: 'benishangul',
      regionName: 'ቤንሻንጉል ጉሙዝ (Benishangul)',
      fertilizerType: 'UREA',
      procuredMT: 12500.00,
      regionalStockMT: 45.00,
      dispatchedMT: 10800.00,
      portCumulativeMT: 1850.00,
      portDailyMT: 1850.00,
      currentRegionStockMT: 8995.00,
      deliveredToRegionMT: 1850.00,
      queueMT: 0,
      hubThisWeekMT: 310.00,
      hubCumulativeMT: 1800.00
    },
    {
      regionId: 'benishangul',
      regionName: 'ቤንሻንጉል ጉሙዝ (Benishangul)',
      fertilizerType: 'NPSB',
      procuredMT: 16800.00,
      regionalStockMT: 30.00,
      dispatchedMT: 14500.00,
      portCumulativeMT: 95.00,
      portDailyMT: 95.00,
      currentRegionStockMT: 14435.00,
      deliveredToRegionMT: 95.00,
      queueMT: 0,
      hubThisWeekMT: 240.00,
      hubCumulativeMT: 1450.00
    }
  ]
};

// Regional Vessel Dispatch & Union Loading Master Data
export const REGIONAL_REPORT_REGIONS: any = [
  { id: 'southEthiopia', name: 'South Ethiopia', amharic: 'ደቡብ ኢትዮጵያ', color: 'border-emerald-500' },
  { id: 'southWestEthiopia', name: 'South West Ethiopia', amharic: 'ደቡብ ምዕራብ ኢትዮጵያ', color: 'border-indigo-500' },
  { id: 'benishangul', name: 'Benishangul', amharic: 'ቤንሻንጉል ጉሙዝ', color: 'border-amber-500' },
  { id: 'sidama', name: 'Sidama', amharic: 'ሲዳማ', color: 'border-teal-500' },
  { id: 'tigray', name: 'Tigray', amharic: 'ትግራይ', color: 'border-purple-500' },
  { id: 'oromia', name: 'Oromia', amharic: 'ኦሮሚያ', color: 'border-red-500' },
  { id: 'amhara', name: 'Amhara', amharic: 'አማራ', color: 'border-blue-500' },
  { id: 'centralEthiopia', name: 'Central Ethiopia', amharic: 'ማዕከላዊ ኢትዮጵያ', color: 'border-cyan-500' },
  { id: 'somali', name: 'Somali', amharic: 'ሶማሌ', color: 'border-orange-500' },
  { id: 'afar', name: 'Afar', amharic: 'አፋር', color: 'border-yellow-500' },
  { id: 'gambella', name: 'Gambella', amharic: 'ጋምቤላ', color: 'border-green-500' }
];

export const INITIAL_REGIONAL_VESSEL_LOTS: any = {
  southEthiopia: [
    {
      lotId: 'LOT-SE-01',
      vesselName: 'M/V PACIFIC SOPHIA / NPSB LOT',
      fertilizerType: 'NPSB',
      status: 'Active Loading',
      lotCode: '7411-2308',
      dateColumns: ['11.04.24', '12.04.24', '13.04.24', '14.04.24', '17.06.24'],
      unions: [
        {
          id: 'u1',
          unionName: 'GAMO',
          destination: 'ARBAMINICH',
          shareMT: 320,
          dailyLoadedMT: {
            '11.04.24': 0,
            '12.04.24': 90,
            '13.04.24': 0,
            '14.04.24': 0,
            '17.06.24': 0
          }
        },
        {
          id: 'u2',
          unionName: 'SOUTH OMO',
          destination: 'JINKA',
          shareMT: 126,
          dailyLoadedMT: {
            '11.04.24': 0,
            '12.04.24': 0,
            '13.04.24': 0,
            '14.04.24': 0,
            '17.06.24': 0
          }
        },
        {
          id: 'u3',
          unionName: 'MILITANA KUSTA',
          destination: 'KARAT(KONSO)',
          shareMT: 454,
          dailyLoadedMT: {
            '11.04.24': 42,
            '12.04.24': 0,
            '13.04.24': 42,
            '14.04.24': 45,
            '17.06.24': 180
          }
        },
        {
          id: 'u4',
          unionName: 'ESGE DICHA',
          destination: 'SAWLA(GOFA)',
          shareMT: 200,
          dailyLoadedMT: {
            '11.04.24': 0,
            '12.04.24': 0,
            '13.04.24': 0,
            '14.04.24': 0,
            '17.06.24': 135
          }
        },
        {
          id: 'u5',
          unionName: 'DAMOTA',
          destination: 'W/SODO',
          shareMT: 400,
          dailyLoadedMT: {
            '11.04.24': 0,
            '12.04.24': 0,
            '13.04.24': 45,
            '14.04.24': 175.5,
            '17.06.24': 0
          }
        }
      ]
    },
    {
      lotId: 'LOT-SE-02',
      vesselName: 'M/V BBG CRIS / UREA LOT',
      fertilizerType: 'UREA',
      status: 'Active Loading',
      lotCode: '7411-2302',
      dateColumns: ['11.04.24', '12.04.24', '13.04.24', '14.04.24'],
      unions: [
        {
          id: 'u6',
          unionName: 'GAMO',
          destination: 'ARBAMINICH',
          shareMT: 230,
          dailyLoadedMT: {
            '11.04.24': 0,
            '12.04.24': 217.5,
            '13.04.24': 0,
            '14.04.24': 45
          }
        },
        {
          id: 'u7',
          unionName: 'MILATANA KUSTA',
          destination: 'KARAT(KONSO)',
          shareMT: 120,
          dailyLoadedMT: {
            '11.04.24': 45.5,
            '12.04.24': 0,
            '13.04.24': 0,
            '14.04.24': 0
          }
        },
        {
          id: 'u8',
          unionName: 'DAMOTA',
          destination: 'W/SODO',
          shareMT: 150,
          dailyLoadedMT: {
            '11.04.24': 0,
            '12.04.24': 0,
            '13.04.24': 90,
            '14.04.24': 0
          }
        }
      ]
    }
  ],

  southWestEthiopia: [
    {
      lotId: 'LOT-SWE-01',
      vesselName: 'M/V PACIFIC SOPHIA / NPSB LOT',
      fertilizerType: 'NPSB',
      status: 'Active Loading',
      lotCode: '7411-2309',
      dateColumns: ['12.04.24', '13.04.24', '14.04.24', '15.04.24'],
      unions: [
        {
          id: 'u9',
          unionName: 'BENCH MAJI',
          destination: 'MIZAN TEFERI',
          shareMT: 350,
          dailyLoadedMT: { '12.04.24': 45, '13.04.24': 90, '14.04.24': 45, '15.04.24': 90 }
        },
        {
          id: 'u10',
          unionName: 'KAFFA UNION',
          destination: 'BONGA',
          shareMT: 420,
          dailyLoadedMT: { '12.04.24': 90, '13.04.24': 45, '14.04.24': 90, '15.04.24': 135 }
        },
        {
          id: 'u11',
          unionName: 'SHEKA UNION',
          destination: 'TEPI',
          shareMT: 180,
          dailyLoadedMT: { '12.04.24': 0, '13.04.24': 45, '14.04.24': 45, '15.04.24': 45 }
        }
      ]
    }
  ],

  benishangul: [
    {
      lotId: 'LOT-BG-01',
      vesselName: 'M/V PACIFIC SOPHIA / NPSB LOT',
      fertilizerType: 'NPSB',
      status: 'Active Loading',
      lotCode: '7411-2310',
      dateColumns: ['11.04.24', '12.04.24', '13.04.24'],
      unions: [
        {
          id: 'u12',
          unionName: 'ASCOMA UNION',
          destination: 'ASSOSA',
          shareMT: 280,
          dailyLoadedMT: { '11.04.24': 45, '12.04.24': 45, '13.04.24': 90 }
        },
        {
          id: 'u13',
          unionName: 'METEKEL UNION',
          destination: 'GILGEL BELES',
          shareMT: 320,
          dailyLoadedMT: { '11.04.24': 0, '12.04.24': 90, '13.04.24': 135 }
        }
      ]
    }
  ],

  sidama: [
    {
      lotId: 'LOT-SD-01',
      vesselName: 'M/V PACIFIC SOPHIA / NPSB LOT',
      fertilizerType: 'NPSB',
      status: 'Active Loading',
      lotCode: '7411-2311',
      dateColumns: ['11.04.24', '12.04.24', '13.04.24', '14.04.24'],
      unions: [
        {
          id: 'u14',
          unionName: 'SIDAMA ELTO',
          destination: 'HAWASSA',
          shareMT: 600,
          dailyLoadedMT: { '11.04.24': 90, '12.04.24': 180, '13.04.24': 135, '14.04.24': 90 }
        },
        {
          id: 'u15',
          unionName: 'WENDO GENET UNION',
          destination: 'WENDO GENET',
          shareMT: 300,
          dailyLoadedMT: { '11.04.24': 45, '12.04.24': 90, '13.04.24': 45, '14.04.24': 45 }
        }
      ]
    }
  ],

  oromia: [
    {
      lotId: 'LOT-OR-01',
      vesselName: 'M/V ABBAY II / NPSB LOT',
      fertilizerType: 'NPSB',
      status: 'Active Loading',
      lotCode: '7411-2301',
      dateColumns: ['10.04.24', '11.04.24', '12.04.24', '13.04.24', '14.04.24'],
      unions: [
        {
          id: 'u16',
          unionName: 'LUME ADAMA',
          destination: 'MOJO HUB',
          shareMT: 1200,
          dailyLoadedMT: { '10.04.24': 180, '11.04.24': 270, '12.04.24': 225, '13.04.24': 180, '14.04.24': 225 }
        },
        {
          id: 'u17',
          unionName: 'AMBO COOP UNION',
          destination: 'AMBO',
          shareMT: 850,
          dailyLoadedMT: { '10.04.24': 90, '11.04.24': 135, '12.04.24': 180, '13.04.24': 135, '14.04.24': 180 }
        },
        {
          id: 'u18',
          unionName: 'ERER UNION',
          destination: 'HARAR / DIRE DAWA',
          shareMT: 650,
          dailyLoadedMT: { '10.04.24': 90, '11.04.24': 90, '12.04.24': 135, '13.04.24': 90, '14.04.24': 135 }
        }
      ]
    }
  ],

  amhara: [
    {
      lotId: 'LOT-AM-01',
      vesselName: 'M/V BBG CRIS / UREA LOT',
      fertilizerType: 'UREA',
      status: 'Active Loading',
      lotCode: '7411-2305',
      dateColumns: ['11.04.24', '12.04.24', '13.04.24', '14.04.24'],
      unions: [
        {
          id: 'u19',
          unionName: 'GUNA UNION',
          destination: 'DEBRE TABOR',
          shareMT: 950,
          dailyLoadedMT: { '11.04.24': 135, '12.04.24': 180, '13.04.24': 180, '14.04.24': 225 }
        },
        {
          id: 'u20',
          unionName: 'DAMOT UNION',
          destination: 'FINOTE SELAM',
          shareMT: 800,
          dailyLoadedMT: { '11.04.24': 90, '12.04.24': 135, '13.04.24': 135, '14.04.24': 180 }
        },
        {
          id: 'u21',
          unionName: 'SELALE UNION',
          destination: 'FITCHE',
          shareMT: 650,
          dailyLoadedMT: { '11.04.24': 90, '12.04.24': 90, '13.04.24': 90, '14.04.24': 135 }
        }
      ]
    }
  ]
};
