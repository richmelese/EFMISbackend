// Business rules & thresholds from the EFMIS Requirements Specification (Aug 2026).
// Values marked "configurable" in the spec can be overridden at runtime through the settings table.

export const RULES = {
  // REQ-1.1-001 validation
  phoneRegex: /^0[79]\d{8}$/, // 09XXXXXXXX or 07XXXXXXXX
  minFarmerNameLength: 3,
  defaultMaxFarmSizeHa: 50,

  ageGroups: ['18-25', '26-35', '36-45', '46-55', '56-65', '65+'],
  educationLevels: ['None', 'Primary', 'Secondary', 'Tertiary'],
  landTenures: ['Owner', 'Tenant', 'Sharecropper', 'Other'],
  genders: ['Male', 'Female'],

  // REQ-1.2-001 fertilizer types & seasons
  fertilizerTypes: ['NPS', 'NPSB', 'UREA', 'DAP', 'NPK_ZN', 'OTHER'],
  seasons: ['Meher', 'Belg', 'Irrigation'],

  // Recommendation per hectare (quintals) — same rates as the DA registration screen (recNpsb = ha*2.0, recUrea = ha*2.4)
  recommendedQtlPerHa: { NPSB: 2.0, UREA: 2.4, NPS: 2.0, DAP: 1.5, NPK_ZN: 1.5, OTHER: 1.0 } as Record<string, number>,

  // REQ-1.1-007 quality checks
  anomalyThresholdPct: 30,
  bulkApprovalMax: 100,

  // REQ-1.3-001 national reconciliation (>1% difference triggers alert)
  reconciliationTolerancePct: 1,

  // REQ-1.4-001 quota defaults (UI weighting sliders)
  defaultQuotaWeights: { historical: 60, soilIndex: 25, arrearsPenalty: 15 },
  minRegionSharePct: 0.5,
  maxRegionSharePct: 50,
  // The quota/aggregation tables split totals into NPSB 58% and Urea 38% (remainder other blends)
  productSplit: { NPSB: 0.58, UREA: 0.38, OTHER: 0.04 },

  // REQ-1.4-002 justification categories
  adjustmentJustificationTypes: [
    'CONFLICT_SECURITY', 'POPULATION_DISPLACEMENT', 'NEW_IRRIGATION_SCHEME', 'CROP_PATTERN_CHANGE', 'PEST_DISEASE_OUTBREAK',
    'MARKET_ACCESS_CHANGE', 'INFRASTRUCTURE_IMPROVEMENT', 'NATURAL_DISASTER', 'OTHER'
  ],

  // REQ-1.4-009 amendment types
  amendmentTypes: [
    'QUANTITY_REDUCTION', 'QUANTITY_INCREASE', 'FERTILIZER_TYPE_CHANGE', 'DELIVERY_WINDOW_CHANGE', 'RECIPIENT_CHANGE',
    'QUALITY_CORRECTION', 'ADMINISTRATIVE_CORRECTION', 'EMERGENCY_ADJUSTMENT'
  ],
  amendmentEscalationPct: 10,

  // REQ-1.3-005 sequential signing order
  demandDocumentSigningOrder: [
    { step: 1, role: 'FTWG', title: 'FTWG Chair' },
    { step: 2, role: 'ATI', title: 'ATI Director General' },
    { step: 3, role: 'MOA', title: 'MoA State Minister' }
  ],

  // REQ-INT-005 severities & SLA hours
  alertSeverities: ['CRITICAL_RED', 'HIGH_ORANGE', 'MEDIUM_YELLOW', 'LOW_BLUE'],
  alertSlaHours: { CRITICAL_RED: 4, HIGH_ORANGE: 24, MEDIUM_YELLOW: 168, LOW_BLUE: 720 } as Record<string, number>,

  // REQ-INT-003 warehouse capacity alert
  warehouseCapacityAlertPct: 80,

  // REQ-1.1-002 uploads
  documentTypes: ['PHOTO', 'NATIONAL_ID_FRONT', 'NATIONAL_ID_BACK', 'LAND_CERTIFICATE', 'KEBELE_ID', 'OTHER', 'EVIDENCE'],
  uploadMimeTypes: ['image/jpeg', 'image/png', 'application/pdf']
};

export type AlertSeverity = 'CRITICAL_RED' | 'HIGH_ORANGE' | 'MEDIUM_YELLOW' | 'LOW_BLUE';
