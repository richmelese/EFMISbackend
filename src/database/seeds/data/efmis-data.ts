// Master data copied from the frontend (EFMIS/js/data.js) - the seed source of truth.
// Ethiopian Fertilizer Supply Chain Management Information System (EFMIS)
// Master Mock Data & State Architecture

export const EFMIS_DATA: any = {
  systemMetadata: {
    version: "2.4.0-Enterprise",
    releaseDate: "August 2026",
    proclamationRef: "Proclamation No. 1078/2018 (Digital Signatures)",
    currentSeason: "Meher 2026",
    seasons: ["Meher 2026", "Belg 2026", "Irrigation 2026-27"],
    nationalTargetMT: 2350000,
    lastRefresh: new Date().toISOString()
  },

  roles: [
    { id: "DA", name: "Development Agent (DA)", level: "Kebele", desc: "Farmer data capture, offline registration & demand intake" },
    { id: "KEBELE", name: "Kebele Agricultural Officer", level: "Kebele", desc: "First-line verification, anomaly detection, kebele signoff" },
    { id: "WOREDA", name: "Woreda Agricultural Officer", level: "Woreda", desc: "Woreda aggregation, adjustment notes, kebele disaggregation" },
    { id: "ZONE", name: "Zone Agricultural Bureau", level: "Zone", desc: "Zonal review, NSIS map overlay, scenario modeling" },
    { id: "REGION", name: "Regional Bureau of Agriculture (BoA)", level: "Region", desc: "Regional demand finalization, quota requests, MoA submission" },
    { id: "MOA", name: "Ministry of Agriculture (MoA)", level: "National", desc: "Gross national forecast, carry-over deduction, official signoff" },
    { id: "FTWG", name: "Fertilizer Technical Working Group", level: "National", desc: "Collaborative technical review, voting, consensus & minutes" },
    { id: "EABC", name: "EABC Procurement Directorate", level: "Enterprise", desc: "Purchase order execution, tenders, supplier contracts, LC & forex" },
    { id: "PMO", name: "Prime Minister's Office (PMO)", level: "Executive", desc: "Executive KPI monitoring, national food security, critical alert SLA" }
  ],

  fertilizerTypes: [
    { code: "NPS", name: "NPS (19-38-0+7S)", unit: "Quintals / MT", color: "#10B981", desc: "Nitrogen-Phosphorus-Sulfur complex blend" },
    { code: "NPSB", name: "NPSB (18.9-37.7-0+6.95S+0.1B)", unit: "Quintals / MT", color: "#059669", desc: "Boron-fortified blend for deficient soils" },
    { code: "UREA", name: "Urea Granular (46% N)", unit: "Quintals / MT", color: "#3B82F6", desc: "High-nitrogen top dressing fertilizer" },
    { code: "DAP", name: "DAP (18-46-0)", unit: "Quintals / MT", color: "#8B5CF6", desc: "Diammonium Phosphate basal application" },
    { code: "NPK_ZN", name: "NPK + Zinc Blends", unit: "Quintals / MT", color: "#F59E0B", desc: "Multi-nutrient specialized soil blend" }
  ],

  regions: [
    {
      id: "REG-OROMIA",
      name: "Oromia Region",
      code: "OR",
      sharePercent: 44.5,
      grossDemandMT: 1045000,
      quotaAllocationMT: 1020000,
      registeredFarmers: 4250000,
      approvalStatus: "Submitted to MoA",
      soilDeficiency: "N, P, S (High), B (Moderate)",
      zones: [
        {
          id: "ZONE-OR-ESHEWA",
          name: "East Shewa Zone",
          woredas: [
            {
              id: "WOR-OR-ADAMA",
              name: "Adama Woreda",
              kebeles: [
                { id: "KEB-01", name: "Wonji Gefersa", da: "Bekele Tadesse", farmers: 640, demandMT: 1820 },
                { id: "KEB-02", name: "Dungugi Boro", da: "Tirhas Haile", farmers: 520, demandMT: 1450 },
                { id: "KEB-03", name: "Boku Shenen", da: "Almaz Gizaw", farmers: 490, demandMT: 1310 }
              ]
            },
            {
              id: "WOR-OR-LUME",
              name: "Lume Woreda (Mojo)",
              kebeles: [
                { id: "KEB-04", name: "Koka Negewo", da: "Derese Gudeta", farmers: 710, demandMT: 2050 },
                { id: "KEB-05", name: "Ejersa Joro", da: "Marta Beyene", farmers: 580, demandMT: 1690 }
              ]
            },
            {
              id: "WOR-OR-DUGDA",
              name: "Dugda Woreda (Meki)",
              kebeles: [
                { id: "KEB-06", name: "Bekele Girissa", da: "Girma Tolosa", farmers: 820, demandMT: 2400 }
              ]
            }
          ]
        },
        {
          id: "ZONE-OR-ARSI",
          name: "Arsi Zone (Asella)",
          woredas: [
            { id: "WOR-OR-TIO", name: "Tiyo Woreda", kebeles: [{ id: "KEB-07", name: "Dosha", da: "Kassahun T.", farmers: 780, demandMT: 2300 }] },
            { id: "WOR-OR-HETOSA", name: "Hetosa Woreda", kebeles: [{ id: "KEB-08", name: "Boru Jawi", da: "Ayantu D.", farmers: 620, demandMT: 1950 }] }
          ]
        },
        {
          id: "ZONE-OR-WESTSHEWA",
          name: "West Shewa Zone (Ambo)",
          woredas: [
            { id: "WOR-OR-AMBO", name: "Ambo Zuria", kebeles: [{ id: "KEB-09", name: "Awaro", da: "Desta M.", farmers: 890, demandMT: 2600 }] }
          ]
        }
      ]
    },
    {
      id: "REG-AMHARA",
      name: "Amhara Region",
      code: "AM",
      sharePercent: 32.2,
      grossDemandMT: 756700,
      quotaAllocationMT: 742000,
      registeredFarmers: 3180000,
      approvalStatus: "Submitted to MoA",
      soilDeficiency: "N, P (Very High), S, Zn",
      zones: [
        {
          id: "ZONE-AM-WGOJJAM",
          name: "West Gojjam Zone",
          woredas: [
            { id: "WOR-AM-FINOTE", name: "Finote Selam Zuria", kebeles: [{ id: "KEB-10", name: "Jiga", da: "Abebe Kasahun", farmers: 920, demandMT: 2750 }] },
            { id: "WOR-AM-MECHA", name: "Mecha Woreda (Merawi)", kebeles: [{ id: "KEB-11", name: "Kurt Bahir", da: "Yared Mekonnen", farmers: 840, demandMT: 2510 }] }
          ]
        },
        {
          id: "ZONE-AM-EGOJJAM",
          name: "East Gojjam Zone",
          woredas: [
            { id: "WOR-AM-DEBREM", name: "Debre Markos Zuria", kebeles: [{ id: "KEB-12", name: "Yedeb", da: "Fasil Assefa", farmers: 730, demandMT: 2100 }] }
          ]
        }
      ]
    },
    {
      id: "REG-SIDAMA",
      name: "Sidama Region",
      code: "SI",
      sharePercent: 7.8,
      grossDemandMT: 183300,
      quotaAllocationMT: 179500,
      registeredFarmers: 890000,
      approvalStatus: "Approved by BoA",
      soilDeficiency: "P, S (Severe Acidity/pH < 5.2)",
      zones: [
        {
          id: "ZONE-SI-CENTRAL",
          name: "Hawassa Zuria Zone",
          woredas: [
            { id: "WOR-SI-HAWASSA", name: "Hawassa Zuria", kebeles: [{ id: "KEB-13", name: "Dore Bafana", da: "Markos Melese", farmers: 680, demandMT: 1780 }] }
          ]
        }
      ]
    },
    {
      id: "REG-SOUTH",
      name: "Central & South Ethiopia",
      code: "SE",
      sharePercent: 8.5,
      grossDemandMT: 199750,
      quotaAllocationMT: 194000,
      registeredFarmers: 1120000,
      approvalStatus: "Pending Regional Signoff",
      soilDeficiency: "N, P, B",
      zones: [
        {
          id: "ZONE-SE-WOLAITA",
          name: "Wolaita Zone",
          woredas: [
            { id: "WOR-SE-SODDO", name: "Soddo Zuria", kebeles: [{ id: "KEB-14", name: "Gutu", da: "Tamirat Dana", farmers: 610, demandMT: 1590 }] }
          ]
        }
      ]
    },
    {
      id: "REG-TIGRAY",
      name: "Tigray Region",
      code: "TI",
      sharePercent: 4.2,
      grossDemandMT: 98700,
      quotaAllocationMT: 96000,
      registeredFarmers: 580000,
      approvalStatus: "Submitted to MoA",
      soilDeficiency: "N, P, Organic Matter Deficit",
      zones: [
        {
          id: "ZONE-TI-CENTRAL",
          name: "Central Tigray Zone",
          woredas: [
            { id: "WOR-TI-AXUM", name: "Laelay Maychew", kebeles: [{ id: "KEB-15", name: "Mahbere Dego", da: "Gebre Gebremariam", farmers: 450, demandMT: 1150 }] }
          ]
        }
      ]
    },
    {
      id: "REG-SOMALI",
      name: "Somali Region",
      code: "SO",
      sharePercent: 1.5,
      grossDemandMT: 35250,
      quotaAllocationMT: 34500,
      registeredFarmers: 190000,
      approvalStatus: "Approved by BoA",
      soilDeficiency: "Salinity, Nitrogen Deficit (Irrigation)",
      zones: [
        {
          id: "ZONE-SO-SHABELLE",
          name: "Shabelle Zone (Gode)",
          woredas: [
            { id: "WOR-SO-GODE", name: "Gode Woreda", kebeles: [{ id: "KEB-16", name: "Hadhave", da: "Mohamed Farah", farmers: 310, demandMT: 780 }] }
          ]
        }
      ]
    },
    {
      id: "REG-OTHER",
      name: "Afar, Benishangul, Gambella & Harari",
      code: "OT",
      sharePercent: 1.3,
      grossDemandMT: 30550,
      quotaAllocationMT: 29800,
      registeredFarmers: 160000,
      approvalStatus: "Submitted to MoA",
      soilDeficiency: "Diverse / High Acidic in Benishangul",
      zones: []
    }
  ],

  // Registered Farmer Records with Fayda & NRLAIS data
  farmerRegistry: [
    {
      id: "FARM-2026-04821",
      name: "Girma Wolde Aragaw",
      faydaId: "FAN-9482-1049-3821",
      faydaStatus: "VERIFIED_ACTIVE",
      nationalIdNumber: "NID-ET-09281744",
      phone: "0911458291",
      gender: "Male",
      ageGroup: "36-45",
      householdSize: 6,
      educationLevel: "Primary",
      primaryOccupation: "Farming",
      region: "Oromia Region",
      zone: "East Shewa Zone",
      woreda: "Adama Woreda",
      kebele: "Wonji Gefersa",
      cooperative: "Wonji Farmers Primary Cooperative Union (ID: PC-OR-882)",
      landCertNumber: "NRLAIS-OR-AD-88492-2024",
      farmSizeHa: 3.75,
      irrigationAccess: "Yes (Awash River Basin Canal)",
      landTenure: "Owner",
      crops: ["Wheat", "Teff", "Sugarcane"],
      demands: [
        { type: "NPSB", requestedQtl: 8.5, recommendedQtl: 7.5, approvedQtl: 7.5, status: "APPROVED" },
        { type: "UREA", requestedQtl: 10.0, recommendedQtl: 9.0, approvedQtl: 9.0, status: "APPROVED" }
      ],
      submissionDate: "2026-08-18",
      daName: "Bekele Tadesse",
      creditScore: 84,
      creditArrearsETB: 0,
      telebirrPhone: "0911458291",
      cbeAccount: "1000284918274",
      photoUrl: "farmer_girma.jpg",
      approvalLevel: "Woreda Approved",
      notes: "High potential irrigated wheat cluster"
    },
    {
      id: "FARM-2026-04822",
      name: "Almaz Hailu Mengesha",
      faydaId: "FAN-8371-9201-4412",
      faydaStatus: "VERIFIED_ACTIVE",
      nationalIdNumber: "NID-ET-04817293",
      phone: "0923881029",
      gender: "Female",
      ageGroup: "46-55",
      householdSize: 5,
      educationLevel: "Secondary",
      primaryOccupation: "Farming",
      region: "Amhara Region",
      zone: "West Gojjam Zone",
      woreda: "Finote Selam Zuria",
      kebele: "Jiga",
      cooperative: "Damot Union - Jiga Primary Cooperative (ID: PC-AM-319)",
      landCertNumber: "NRLAIS-AM-FS-49102-2023",
      farmSizeHa: 2.50,
      irrigationAccess: "No (Rainfed Meher)",
      landTenure: "Owner",
      crops: ["Maize", "Teff"],
      demands: [
        { type: "NPS", requestedQtl: 6.0, recommendedQtl: 5.0, approvedQtl: 5.0, status: "APPROVED" },
        { type: "UREA", requestedQtl: 7.5, recommendedQtl: 6.0, approvedQtl: 6.0, status: "APPROVED" }
      ],
      submissionDate: "2026-08-19",
      daName: "Abebe Kasahun",
      creditScore: 92,
      creditArrearsETB: 0,
      telebirrPhone: "0923881029",
      cbeAccount: "1000392817221",
      photoUrl: "farmer_almaz.jpg",
      approvalLevel: "Zone Approved",
      notes: "Acidic soil zone, requires lime + NPS"
    },
    {
      id: "FARM-2026-04823",
      name: "Chala Gemechu Roba",
      faydaId: "FAN-3829-1920-5541",
      faydaStatus: "VERIFIED_ACTIVE",
      nationalIdNumber: "NID-ET-05829104",
      phone: "0711928374",
      gender: "Male",
      ageGroup: "26-35",
      householdSize: 4,
      educationLevel: "Tertiary",
      primaryOccupation: "Farming & Agro-Dealer",
      region: "Oromia Region",
      zone: "East Shewa Zone",
      woreda: "Lume Woreda (Mojo)",
      kebele: "Koka Negewo",
      cooperative: "Lume Adama Union (ID: PC-OR-104)",
      landCertNumber: "NRLAIS-OR-LU-38291-2025",
      farmSizeHa: 5.20,
      irrigationAccess: "Yes (Koka Dam Pump)",
      landTenure: "Owner",
      crops: ["Wheat", "Vegetables/Onion", "Barley"],
      demands: [
        { type: "NPSB", requestedQtl: 14.0, recommendedQtl: 10.5, approvedQtl: null, status: "FLAGGED_ANOMALY" },
        { type: "UREA", requestedQtl: 16.0, recommendedQtl: 12.0, approvedQtl: null, status: "FLAGGED_ANOMALY" }
      ],
      submissionDate: "2026-08-20",
      daName: "Derese Gudeta",
      creditScore: 68,
      creditArrearsETB: 14500,
      telebirrPhone: "0711928374",
      cbeAccount: "1000492817234",
      photoUrl: "farmer_chala.jpg",
      approvalLevel: "Pending Kebele Review",
      notes: "Anomaly flagged: requested amount exceeds NSIS rate by +33.3% and outstanding credit arrears exist."
    },
    {
      id: "FARM-2026-04824",
      name: "Ayelech Markos Tadesse",
      faydaId: "FAN-1092-8472-9102",
      faydaStatus: "VERIFIED_ACTIVE",
      nationalIdNumber: "NID-ET-08392811",
      phone: "0916382910",
      gender: "Female",
      ageGroup: "36-45",
      householdSize: 7,
      educationLevel: "Primary",
      primaryOccupation: "Farming",
      region: "Sidama Region",
      zone: "Hawassa Zuria Zone",
      woreda: "Hawassa Zuria",
      kebele: "Dore Bafana",
      cooperative: "Sidama Elto Union (ID: PC-SI-049)",
      landCertNumber: "NRLAIS-SI-HW-19283-2024",
      farmSizeHa: 1.80,
      irrigationAccess: "No",
      landTenure: "Owner",
      crops: ["Enset", "Maize", "Coffee"],
      demands: [
        { type: "NPSB", requestedQtl: 3.5, recommendedQtl: 3.5, approvedQtl: 3.5, status: "APPROVED" },
        { type: "UREA", requestedQtl: 4.0, recommendedQtl: 4.0, approvedQtl: 4.0, status: "APPROVED" }
      ],
      submissionDate: "2026-08-21",
      daName: "Markos Melese",
      creditScore: 95,
      creditArrearsETB: 0,
      telebirrPhone: "0916382910",
      cbeAccount: "1000592817289",
      photoUrl: "farmer_ayelech.jpg",
      approvalLevel: "Region Approved",
      notes: "Coffee agro-forestry intercropped with maize"
    }
  ],

  // Carry-Over Stocks (REQ-1.3-004)
  carryOverStocks: {
    totalUsableMT: 285400,
    totalExpiredSubstandardMT: 14200,
    byFacilityType: [
      { facility: "Central Strategic Warehouses (Nazret, Mojo, Kombolcha)", usableMT: 112000, unverifiedMT: 2100, qcPassPercent: 98.1 },
      { facility: "Regional Buffer Depots (Oromia, Amhara, SNNP, Sidama)", usableMT: 96400, unverifiedMT: 3500, qcPassPercent: 96.4 },
      { facility: "Cooperative Union Hubs (42 Unions nationwide)", usableMT: 54000, unverifiedMT: 4800, qcPassPercent: 92.0 },
      { facility: "Primary Cooperative (PC) Stores (Last Mile)", usableMT: 23000, unverifiedMT: 3800, qcPassPercent: 88.5 }
    ],
    byFertilizer: [
      { type: "NPS", stockMT: 104000, usableMT: 99500, expiredMT: 4500, qcStatus: "PASSED (ECAE Batch #ET-25-NPS-09)" },
      { type: "NPSB", stockMT: 78000, usableMT: 74200, expiredMT: 3800, qcStatus: "PASSED (ECAE Batch #ET-25-NPSB-14)" },
      { type: "UREA", stockMT: 92000, usableMT: 88200, expiredMT: 3800, qcStatus: "PASSED (ECAE Batch #ET-25-UR-31)" },
      { type: "DAP", stockMT: 25000, usableMT: 23500, expiredMT: 1500, qcStatus: "PASSED (ECAE Batch #ET-25-DAP-02)" },
      { type: "NPK+Zn", stockMT: 600, usableMT: 0, expiredMT: 600, qcStatus: "REJECTED (Caked / Moisture > 3.8%)" }
    ]
  },

  // EABC Procurement & Tenders (REQ-INT-001 & REQ-1.4-010)
  procurement: {
    activeTenders: [
      {
        tenderNo: "EABC/MOA/ICB/FERT-2026/001",
        description: "Supply of 650,000 MT Granular Urea (Bulk with bagging at Port Djibouti)",
        stage: "Financial Evaluation",
        deadline: "2026-09-15",
        budgetAllocatedETB: "34,800,000,000 ETB",
        forexRequiredUSD: "$380,000,000 USD",
        forexStatus: "Approved by NBE (Batch 1)",
        lcIssuingBank: "Commercial Bank of Ethiopia (CBE - Central Branch)",
        lcStatus: "LC Confirmed (#LC-2026-CBE-9941)",
        lowestBidder: "OCP Africa / Yara International JV",
        complianceStatus: "ESA Standard ES 684:2024 Compliant"
      },
      {
        tenderNo: "EABC/MOA/ICB/FERT-2026/002",
        description: "Supply of 850,000 MT NPS & NPSB Fortified Blend",
        stage: "Contract Awarded",
        deadline: "2026-08-30",
        budgetAllocatedETB: "47,600,000,000 ETB",
        forexRequiredUSD: "$520,000,000 USD",
        forexStatus: "Disbursed 60% Advance",
        lcIssuingBank: "Commercial Bank of Ethiopia",
        lcStatus: "Operative & Active",
        lowestBidder: "OCP Group Morocco",
        complianceStatus: "ECAE Pre-Shipment Inspection Passed"
      }
    ],
    vessels: [
      {
        name: "MV Abbay II (ESLSE Flagship)",
        imo: "9617284",
        cargo: "55,000 MT NPSB",
        origin: "Jorf Lasfar, Morocco",
        laycan: "2026-08-20 to 2026-08-26",
        etaDjibouti: "2026-08-27 06:00",
        berthingStatus: "Berth #12 Allocated (DMP Djibouti Multipurpose Port)",
        unloadingRateTPD: "6,500 MT/Day",
        demurrageRisk: "LOW (0 Days Demurrage)",
        destinationDepots: ["Mojo Central Hub", "Nazret Buffer", "Adama Union"]
      },
      {
        name: "MV Gibe",
        imo: "9582190",
        cargo: "50,000 MT Granular Urea",
        origin: "Ras Al Khair, Saudi Arabia",
        laycan: "2026-08-25 to 2026-08-31",
        etaDjibouti: "2026-09-02 14:00",
        berthingStatus: "Anchorage Outer Roadstead",
        unloadingRateTPD: "7,000 MT/Day",
        demurrageRisk: "NORMAL",
        destinationDepots: ["Kombolcha Hub", "Bahir Dar Depot"]
      }
    ]
  },

  // Logistics & Real-Time Fleet Tracking (REQ-INT-003)
  logistics: {
    activeTrucksInTransit: 1480,
    totalDispatchedMT: 342000,
    dailyDeliveryRateMT: 18500,
    bottlenecks: [
      { location: "Galafi Border Crossing (Djibouti-Ethiopia)", delayHours: 4.2, cause: "Customs EDI batch sync queue" },
      { location: "Mille Weighbridge", delayHours: 1.5, cause: "Axle weight calibration check" }
    ],
    gpsFleet: [
      { truckId: "ESLSE-TRK-8819", driver: "Tadesse Hailu", vehicleNo: "3-ET-89412", cargo: "40 MT NPSB (Bagged with QR)", lat: 11.588, lng: 42.502, speedKmH: 58, route: "Djibouti DMP -> Mojo Central Hub", eta: "16h 20m", status: "NORMAL_MOVING", qrLot: "LOT-MOR-2026-NPSB-01" },
      { truckId: "ESLSE-TRK-9042", driver: "Kibret Mengistu", vehicleNo: "3-ET-71028", cargo: "40 MT Urea", lat: 11.205, lng: 41.810, speedKmH: 62, route: "Djibouti DMP -> Kombolcha Hub", eta: "12h 45m", status: "NORMAL_MOVING", qrLot: "LOT-SAU-2026-UR-04" },
      { truckId: "PRIVATE-TRK-109", driver: "Ahmed Nur", vehicleNo: "3-ET-65419", cargo: "38 MT NPS", lat: 8.541, lng: 39.271, speedKmH: 0, route: "Mojo Hub -> Adama Union PC-882", eta: "1h 10m", status: "UNLOADING", qrLot: "LOT-MOR-2026-NPS-02" },
      { truckId: "PRIVATE-TRK-381", driver: "Girma Belay", vehicleNo: "3-ET-48190", cargo: "40 MT DAP", lat: 9.352, lng: 40.125, speedKmH: 0, route: "Galafi -> Hawassa Hub", eta: "DELAYED", status: "STOPPED_ALERT", qrLot: "LOT-CHN-2026-DAP-07", alertReason: "Stationary for > 3.5 hrs outside designated rest stop (Awash)" }
    ],
    warehouseUtilization: [
      { name: "Mojo Central Mega-Hub", capacityMT: 150000, currentStockMT: 128000, utilPercent: 85.3, status: "CAPACITY_ALERT_80" },
      { name: "Nazret Buffer Depot", capacityMT: 100000, currentStockMT: 72000, utilPercent: 72.0, status: "OPTIMAL" },
      { name: "Kombolcha Regional Hub", capacityMT: 80000, currentStockMT: 61000, utilPercent: 76.2, status: "OPTIMAL" },
      { name: "Bahir Dar Regional Depot", capacityMT: 90000, currentStockMT: 78500, utilPercent: 87.2, status: "CAPACITY_ALERT_80" },
      { name: "Hawassa Buffer Depot", capacityMT: 60000, currentStockMT: 41000, utilPercent: 68.3, status: "OPTIMAL" },
      { name: "Dire Dawa Warehouse", capacityMT: 40000, currentStockMT: 22000, utilPercent: 55.0, status: "OPTIMAL" }
    ]
  },

  // Quality & ECAE Lab Inspection (REQ-INT-002)
  qualityControl: {
    overallPassRate: 99.4,
    testedBatchesCount: 418,
    inspections: [
      {
        sampleId: "ECAE-LAB-2026-0819",
        vessel: "MV Abbay II",
        product: "NPSB Granular",
        supplier: "OCP Africa",
        inspectionDate: "2026-08-22",
        labLocation: "ECAE Central Quality Lab (Addis Ababa)",
        nitrogenContent: "19.04% (Standard: 19.0 ± 0.5%)",
        phosphorusP2O5: "38.12% (Standard: 38.0 ± 0.5%)",
        sulfurS: "7.10% (Standard: 7.0 ± 0.3%)",
        boronB: "0.108% (Standard: 0.10 ± 0.02%)",
        moisture: "0.85% (Standard: Max 1.5%)",
        cadmiumHeavyMetal: "6.2 mg/kg (Standard: Max 20 mg/kg)",
        leadHeavyMetal: "1.8 mg/kg (Standard: Max 10 mg/kg)",
        granulation2to4mm: "94.2% (Standard: Min 90%)",
        verdict: "PASSED_CONFORMITY",
        cocNumber: "CoC-ECAE-2026-FDRE-89102",
        qrVerificationCode: "VERIFY-ECAE-89102-PKI"
      },
      {
        sampleId: "ECAE-LAB-2026-0814",
        vessel: "MV Gibe",
        product: "Granular Urea (46% N)",
        supplier: "SABIC Agri-Nutrients",
        inspectionDate: "2026-08-21",
        labLocation: "ECAE Djibouti Port Fast Lab",
        nitrogenContent: "46.21% (Standard: Min 46.0%)",
        moisture: "0.32% (Standard: Max 0.5%)",
        biuret: "0.88% (Standard: Max 1.0%)",
        verdict: "PASSED_CONFORMITY",
        cocNumber: "CoC-ECAE-2026-FDRE-89044",
        qrVerificationCode: "VERIFY-ECAE-89044-PKI"
      },
      {
        sampleId: "ECAE-LAB-2026-0799",
        vessel: "MV Bulk Express (Substandard Batch Flag)",
        product: "DAP Basal",
        supplier: "Blacklisted Trader XYZ",
        inspectionDate: "2026-07-28",
        labLocation: "ECAE Central Lab",
        nitrogenContent: "14.2% (Standard: Min 18.0%) - DEFICIENT",
        phosphorusP2O5: "39.1% (Standard: Min 46.0%) - DEFICIENT",
        moisture: "4.1% (Standard: Max 2.5%) - CAKED",
        verdict: "REJECTED_IMPOUNDED",
        cocNumber: "REJECT-NOTICE-2026-004",
        qrVerificationCode: "IMPOUNDED-LOT-9921",
        incidentReport: "Impounded at Djibouti port quayside; Supplier barred from Ethiopian ICB tenders per FDRE Directive."
      }
    ]
  },

  // Financial & Farmer Repayment Metrics (REQ-INT-004)
  financials: {
    totalSalesETB: "68,400,000,000 ETB",
    telebirrCollectionETB: "42,800,000,000 ETB (62.5%)",
    cbeBankVoucherETB: "22,100,000,000 ETB (32.3%)",
    cashCollectionETB: "3,500,000,000 ETB (5.2%)",
    nationalRepaymentRate: 94.8,
    ecxMarketPrices: [
      { commodity: "White Teff (Addis Ababa Grade 1)", priceETBPerQtl: 14200, trend: "+2.4%" },
      { commodity: "Bread Wheat (Adama Central Market)", priceETBPerQtl: 7800, trend: "+1.1%" },
      { commodity: "Maize White (Bako / Nekemte)", priceETBPerQtl: 4600, trend: "-0.5%" },
      { commodity: "Haricot Bean Red (Nazret)", priceETBPerQtl: 6900, trend: "+3.2%" }
    ]
  },

  // Critical Alerts with PMO 4-Hour SLA (REQ-INT-005)
  criticalAlerts: [
    {
      id: "ALT-2026-0091",
      severity: "CRITICAL_RED",
      title: "Substandard Fertilizer Lot Detected & Barred",
      category: "Quality Compliance",
      trigger: "ECAE Destination Test Failed on Batch #ET-DAP-9921 (P2O5 deficient by 15%)",
      affectedArea: "Djibouti Port Quayside / National Reserve",
      slaHoursRemaining: 1.5,
      pmoNotificationStatus: "ESCALATED_TO_PMO",
      actionRequired: "Confirm supplier debarment and execute LC performance guarantee bond draw.",
      timestamp: "2026-08-24 10:15",
      resolved: false
    },
    {
      id: "ALT-2026-0092",
      severity: "HIGH_ORANGE",
      title: "Storage Capacity Exceeded 85% at Mojo Central Mega-Hub",
      category: "Logistics & Warehousing",
      trigger: "Total inventory reached 128,000 MT against 150,000 MT max design threshold",
      affectedArea: "East Shewa, Mojo",
      slaHoursRemaining: 8.0,
      pmoNotificationStatus: "NOTIFIED_MOA",
      actionRequired: "Accelerate secondary transport dispatches to Oromia & Sidama Union warehouses.",
      timestamp: "2026-08-24 11:30",
      resolved: false
    },
    {
      id: "ALT-2026-0093",
      severity: "HIGH_ORANGE",
      title: "Excessive Demand Variance Flagged in Lume Woreda",
      category: "Demand Anomaly",
      trigger: "+33.3% spike detected above 5-year historical average (Koka Negewo cluster)",
      affectedArea: "Oromia / East Shewa / Lume Woreda",
      slaHoursRemaining: 14.0,
      pmoNotificationStatus: "NOTIFIED_ZONE",
      actionRequired: "Woreda & Zone Agronomist field audit on farm size certificate verification.",
      timestamp: "2026-08-24 09:00",
      resolved: false
    },
    {
      id: "ALT-2026-0094",
      severity: "MEDIUM_YELLOW",
      title: "Galafi Border EDI Sync Queue Delay",
      category: "Customs Integration",
      trigger: "Average wait time increased from 1.2 hrs to 4.2 hrs due to telecom network maintenance",
      affectedArea: "Afar / Galafi Border Post",
      slaHoursRemaining: 24.0,
      pmoNotificationStatus: "NORMAL",
      actionRequired: "Activate secondary Ethio Telecom satellite uplink backup.",
      timestamp: "2026-08-24 08:30",
      resolved: true
    }
  ],

  // System Audit Trail (REQ-1.7-002)
  auditTrail: [
    { id: "AUD-89102", timestamp: "2026-08-24 12:45:10", user: "State Minister Dr. Melesse (MoA)", role: "MOA", action: "DIGITAL_SIGNATURE_APPLIED", target: "DOC-DEMAND-2026-FINAL", hash: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", ip: "197.156.77.12" },
    { id: "AUD-89101", timestamp: "2026-08-24 11:30:22", user: "DG Mandefro (ATI)", role: "ATI", action: "DOC_CO_SIGNATURE", target: "DOC-DEMAND-2026-FINAL", hash: "sha256:a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0", ip: "197.156.77.45" },
    { id: "AUD-89100", timestamp: "2026-08-24 10:15:00", user: "Dr. Kassa (FTWG Chair)", role: "FTWG", action: "CONSENSUS_VOTE_CLOSED", target: "FTWG-SESSION-MEHER-26", hash: "sha256:7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069", ip: "197.156.88.90" },
    { id: "AUD-89099", timestamp: "2026-08-24 09:20:18", user: "Bekele Tadesse (DA-OR-01)", role: "DA", action: "FARMER_REGISTRATION_OFFLINE_SYNC", target: "FARM-2026-04821", hash: "sha256:cb338ecb97c8d96b99480d44081079545582f3ef8fa0ffb4a62174c803ffcbb4", ip: "10.240.19.4" },
    { id: "AUD-89098", timestamp: "2026-08-24 08:44:55", user: "ECAE Chief Chemist", role: "ECAE", action: "LAB_TEST_COC_ISSUED", target: "CoC-ECAE-2026-FDRE-89102", hash: "sha256:3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b", ip: "197.156.12.80" }
  ]
};

