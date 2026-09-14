export interface BenchmarkInstanceCapacity {
  vcpus: number;
  memoryGiB: number;
}

export interface BenchmarkWorkerResources {
  cpu: string;
  memory: string;
}

export const SUPPORTED_BENCHMARK_INSTANCES = {
  "c5n.2xlarge": { vcpus: 8, memoryGiB: 21 },
  "c5n.4xlarge": { vcpus: 16, memoryGiB: 42 },
  "m5.2xlarge": { vcpus: 8, memoryGiB: 32 },
  "m5.4xlarge": { vcpus: 16, memoryGiB: 64 },
  "r5.2xlarge": { vcpus: 8, memoryGiB: 64 },
  "r5.4xlarge": { vcpus: 16, memoryGiB: 128 },
} as const satisfies Record<string, BenchmarkInstanceCapacity>;

export type SupportedBenchmarkInstanceType =
  keyof typeof SUPPORTED_BENCHMARK_INSTANCES;

export const SUPPORTED_BENCHMARK_INSTANCE_TYPES = Object.keys(
  SUPPORTED_BENCHMARK_INSTANCES,
) as SupportedBenchmarkInstanceType[];

const SYSTEM_RESERVED_VCPUS = 1;
const SYSTEM_RESERVED_MEMORY_GIB = 4;

export function benchmarkWorkerResources(
  instanceType: string,
): BenchmarkWorkerResources | undefined {
  if (!Object.hasOwn(SUPPORTED_BENCHMARK_INSTANCES, instanceType)) {
    return undefined;
  }
  const capacity =
    SUPPORTED_BENCHMARK_INSTANCES[
      instanceType as SupportedBenchmarkInstanceType
    ];
  return {
    cpu: String(capacity.vcpus - SYSTEM_RESERVED_VCPUS),
    memory: `${capacity.memoryGiB - SYSTEM_RESERVED_MEMORY_GIB}Gi`,
  };
}
