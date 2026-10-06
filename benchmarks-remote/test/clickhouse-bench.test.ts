import assert from "node:assert/strict";
import test from "node:test";

import {
  clickhouseDialect,
  clickhouseQueryResponseSchema,
  clickhouseTableSource,
  clickhouseTableUrl,
} from "../src/bin/clickhouse-bench";

test("reads Parquet tables across the ClickHouse cluster", () => {
  const lineitem = {
    suite: "tpch",
    schema: "tpch_sf10",
    name: "lineitem",
    s3Path: "s3://datasets/tpch/sf10/lineitem/",
    fileType: "PARQUET",
  };
  const url = clickhouseTableUrl(lineitem, "us-east-1");
  assert.equal(
    url,
    "https://datasets.s3.us-east-1.amazonaws.com/tpch/sf10/lineitem/*.parquet",
  );
  assert.equal(
    clickhouseTableSource(lineitem, url, [
      ["l_orderkey", "Int64"],
      ["l_quantity", "Decimal(15, 2)"],
    ]),
    "s3Cluster('benchmark', 'https://datasets.s3.us-east-1.amazonaws.com/tpch/sf10/lineitem/*.parquet', 'Parquet', '`l_orderkey` Int64, `l_quantity` Decimal(15, 2)')",
  );
});

test("reads ClickBench event dates as dates", () => {
  assert.equal(
    clickhouseTableSource(
      {
        suite: "clickbench",
        schema: "clickbench_0-100",
        name: "hits",
        s3Path: "s3://datasets/clickbench/0-100/hits/",
        fileType: "PARQUET",
      },
      "https://datasets.s3.eu-west-1.amazonaws.com/clickbench/0-100/hits/*.parquet",
      [
        ["EventDate", "Nullable(UInt16)"],
        ["Title", "Nullable(String)"],
      ],
    ),
    "s3Cluster('benchmark', 'https://datasets.s3.eu-west-1.amazonaws.com/clickbench/0-100/hits/*.parquet', 'Parquet', '`EventDate` Date, `Title` Nullable(String)')",
  );
});

test("translates shared benchmark SQL to the ClickHouse dialect", () => {
  assert.equal(
    clickhouseDialect(
      `SELECT extract(minute FROM to_timestamp_seconds("EventTime")), REGEXP_REPLACE("Referer", '^(.*)$', '\\1') FROM hits`,
    ),
    `SELECT extract(minute FROM toDateTime("EventTime")), REGEXP_REPLACE("Referer", '^(.*)$', '\\\\1') FROM hits`,
  );
  assert.match(
    clickhouseDialect(
      "create view revenue0 (supplier_no, total_revenue) as\n\tselect\n\t\tl_suppkey,\n\t\tsum(l_extendedprice * (1 - l_discount))\n\tfrom lineitem",
    ),
    /^create view revenue0 as select l_suppkey as supplier_no, sum\(l_extendedprice \* \(1 - l_discount\)\) as total_revenue/,
  );
});

test("validates ClickHouse JSONCompact responses", () => {
  assert.equal(
    clickhouseQueryResponseSchema.parse({
      meta: [{ name: "count()", type: "UInt64" }],
      data: [[42]],
      rows: 1,
      statistics: { elapsed: 0.25, rows_read: 42, bytes_read: 336 },
    }).statistics.elapsed,
    0.25,
  );
  assert.throws(() =>
    clickhouseQueryResponseSchema.parse({ rows: 1, statistics: {} }),
  );
});
