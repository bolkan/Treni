import unittest

from scripts.collect import normalize, parse_stations, parse_autocomplete, normalize_train, monitored_ids, safe_time


class CollectorTests(unittest.TestCase):
    def test_names_and_accents(self):
        self.assertEqual(normalize(" Giarre-Riposto "), "GIARRE RIPOSTO")
        self.assertEqual(normalize("Città"), "CITTA")

    def test_station_parser(self):
        payload = [
            {"codiceStazione":"S01700","localita":{"nomeLungo":"MILANO CENTRALE"}},
            {"id":"S06421","nomeLungo":"FIRENZE S.M.N."},
            {"id":"bad","nomeLungo":"IGNORA"},
        ]
        self.assertEqual(len(parse_stations(payload)),2)

    def test_autocomplete(self):
        result = parse_autocomplete("CATANIA CENTRALE|S12345\nINVALIDA\n")
        self.assertEqual(result,[{"id":"S12345","name":"CATANIA CENTRALE"}])

    def test_monitored_names(self):
        stations=[{"id":"S01700","name":"MILANO CENTRALE"},{"id":"S06421","name":"FIRENZE S.M.N."}]
        selected,unresolved=monitored_ids(stations,["MILANO CENTRALE","ROMA TERMINI"])
        self.assertEqual([x["id"] for x in selected],["S01700"])
        self.assertEqual(unresolved,["ROMA TERMINI"])

    def test_normalize_train(self):
        raw={
            "numeroTreno":12980,"categoriaDescrizione":" REG","destinazione":"MESSINA CENTRALE",
            "compOrarioPartenza":"07:05","ritardo":8,
            "binarioProgrammatoPartenzaDescrizione":"2","provvedimento":0
        }
        train=normalize_train(raw,"departures")
        self.assertEqual(train["number"],"12980")
        self.assertEqual(train["scheduled"],"07:05")
        self.assertEqual(train["delay"],8)
        self.assertEqual(train["platformPlanned"],"2")
        self.assertFalse(train["cancelled"])

    def test_cancelled(self):
        train=normalize_train({"numeroTreno":1234,"provvedimento":1},"arrivals")
        self.assertTrue(train["cancelled"])
        self.assertIsNone(train["delay"])

    def test_time(self):
        self.assertEqual(safe_time("5:09"),"05:09")
        self.assertIsNone(safe_time("ignoto"))


if __name__ == "__main__":
    unittest.main()
