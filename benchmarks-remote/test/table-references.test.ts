import assert from "node:assert/strict";
import test from "node:test";

import { replaceTableReferences } from "../src/lib/table-references";

const sources = new Map([
  ["lineitem", "src(lineitem)"],
  ["nation", "src(nation)"],
  ["orders", "src(orders)"],
  ["date_dim", "src(date_dim)"],
  ["hits", "src(hits)"],
]);

test("replaces tables in FROM and JOIN positions", () => {
  assert.equal(
    replaceTableReferences(
      "select count(*) from lineitem join orders on l_orderkey = o_orderkey",
      sources,
    ),
    "select count(*) from src(lineitem) AS lineitem join src(orders) AS orders on l_orderkey = o_orderkey",
  );
  assert.equal(
    replaceTableReferences("SELECT COUNT(*) FROM hits;", sources),
    "SELECT COUNT(*) FROM src(hits) AS hits;",
  );
});

test("keeps existing table aliases", () => {
  assert.equal(
    replaceTableReferences(
      "select * from nation n1, nation as n2, orders where n1.n_nationkey = 1",
      sources,
    ),
    "select * from src(nation) n1, src(nation) as n2, src(orders) AS orders where n1.n_nationkey = 1",
  );
});

test("keeps the table name as alias for qualified columns", () => {
  assert.equal(
    replaceTableReferences(
      "select date_dim.d_year from date_dim where date_dim.d_dom = 1",
      sources,
    ),
    "select date_dim.d_year from src(date_dim) AS date_dim where date_dim.d_dom = 1",
  );
});

test("leaves columns, aliases, strings, and comments unchanged", () => {
  const sql = [
    "-- from lineitem",
    "select n_name as nation, extract(year from o_orderdate) as orders,",
    "  'from lineitem' as label",
    "from (select * from orders) as lineitem",
    "group by nation, orders",
  ].join("\n");
  assert.equal(
    replaceTableReferences(sql, sources),
    sql.replace(
      "(select * from orders)",
      "(select * from src(orders) AS orders)",
    ),
  );
});

test("replaces tables inside subqueries and common table expressions", () => {
  assert.equal(
    replaceTableReferences(
      "with x as (select * from lineitem) select * from x where exists (select 1 from orders o) union all select * from nation",
      sources,
    ),
    "with x as (select * from src(lineitem) AS lineitem) select * from x where exists (select 1 from src(orders) o) union all select * from src(nation) AS nation",
  );
});
