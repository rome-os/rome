// The Apple Health source: the only Health-specific file in core. The units
// are the first unit of each type in the iOS app's `HealthTypes.all`, which the
// phone sends. Contract: docs/user-data.md.

import type { SourceSpec, TypeSpec, UnitConversion } from "../domain/source.js";

const length: UnitConversion[] = [
  { name: "km", factor: 1 / 1000 },
  { name: "mi", factor: 1 / 1609.344 },
  { name: "ft", factor: 1 / 0.3048 },
];
const height: UnitConversion[] = [
  { name: "cm", factor: 100 },
  { name: "ft", factor: 1 / 0.3048 },
  { name: "in", factor: 1 / 0.0254 },
];
const energy: UnitConversion[] = [{ name: "kJ", factor: 4.184 }];
const time: UnitConversion[] = [
  { name: "s", factor: 60 },
  { name: "h", factor: 1 / 60 },
];
const mass: UnitConversion[] = [
  { name: "g", factor: 1000 },
  { name: "lb", factor: 1 / 0.45359237 },
];
const volume: UnitConversion[] = [
  { name: "L", factor: 1 / 1000 },
  { name: "fl_oz_us", factor: 1 / 29.5735295625 },
];

const hourAndDay = ["hour", "day"] as const;

function summed(type: string, unit: string, conversions?: UnitConversion[]): TypeSpec {
  return { type, shape: "bucket", unit, resolutions: hourAndDay, rollup: "sum", conversions };
}

function averaged(type: string, unit: string): TypeSpec {
  return { type, shape: "bucket", unit, resolutions: hourAndDay, rollup: "avg" };
}

function sampled(type: string, unit: string, conversions?: UnitConversion[]): TypeSpec {
  return { type, shape: "sample", unit, rollup: "avg", conversions };
}

export const APPLE_HEALTH: SourceSpec = {
  source: "apple_health",
  title: "Apple Health",
  note:
    "Pushed from the guardian's iPhone in the background, usually within an hour; sleep once a day. " +
    "Hourly and daily buckets; workouts, sleep nights and body readings as records. " +
    "A day with no value had no data or the type is not allowed in iOS.",
  types: [
    summed("stepCount", "count"),
    summed("distanceWalkingRunning", "m", length),
    summed("distanceCycling", "m", length),
    summed("flightsClimbed", "count"),
    summed("activeEnergyBurned", "kcal", energy),
    summed("basalEnergyBurned", "kcal", energy),
    summed("appleExerciseTime", "min", time),
    summed("appleStandTime", "min", time),
    summed("dietaryEnergyConsumed", "kcal", energy),
    summed("dietaryWater", "mL", volume),
    averaged("heartRate", "count/min"),
    averaged("respiratoryRate", "count/min"),
    averaged("oxygenSaturation", "%"),
    averaged("heartRateVariabilitySDNN", "ms"),
    sampled("restingHeartRate", "count/min"),
    sampled("walkingHeartRateAverage", "count/min"),
    sampled("vo2Max", "ml/(kg*min)"),
    sampled("bodyMass", "kg", mass),
    sampled("bodyMassIndex", "count"),
    sampled("bodyFatPercentage", "%"),
    sampled("height", "m", height),
    sampled("bloodPressureSystolic", "mmHg"),
    sampled("bloodPressureDiastolic", "mmHg"),
    sampled("bloodGlucose", "mg/dL"),
    sampled("bodyTemperature", "degC", [{ name: "degF", factor: 9 / 5, offset: 32 }]),
    {
      type: "mindfulSession",
      shape: "sample",
      unit: "min",
      rollup: "sum",
      conversions: time,
    },
    {
      type: "sleep",
      shape: "record",
      unit: "min",
      rollup: "sum",
      note: "One record per night, keyed by its wake date: asleep minutes, with minutes per stage in fields.",
    },
    {
      type: "workouts",
      shape: "record",
      unit: "min",
      rollup: "sum",
      note: "One record per workout: its duration, with energy and distance in fields and the activity in metadata.",
    },
  ],
  metadataKeys: ["activity", "sourceApp"],
  live: {
    how: "rome-node device run <device> health.stats",
    when: "only while the Rome app is open on the iPhone",
  },
};
