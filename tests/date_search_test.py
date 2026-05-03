import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.date_search import build_date_search_aliases, normalized_search_matches


class DateSearchNormalizationTest(unittest.TestCase):
    def test_equivalent_date_queries_return_same_records(self):
        record_values = ["2026-05-03", "2026-05-10"]
        queries = ["5/3", "5/03", "05/3", "05/03", "May 3", "may 3", "MAY 3"]
        baseline = None

        for query in queries:
            matches = [
                index
                for index, value in enumerate(record_values)
                if normalized_search_matches(query, [value])
            ]
            self.assertEqual(matches, [0])
            if baseline is None:
                baseline = matches
            self.assertEqual(matches, baseline)

    def test_year_month_day_expands_to_user_friendly_aliases(self):
        aliases = build_date_search_aliases("2026-05-03")
        self.assertIn("5/3", aliases)
        self.assertIn("05/03", aliases)
        self.assertIn("may 3", aliases)

    def test_general_text_search_still_works(self):
        self.assertTrue(normalized_search_matches("buyer", ["Buyer Name"]))


if __name__ == "__main__":
    unittest.main()

