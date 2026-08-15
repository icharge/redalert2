System.register("engine/sound/EvaSpecs", ["game/SideType"], function (t, e) {
  "use strict";
  var a, o, l, i;
  e && e.id;
  return {
    setters: [
      function (e) {
        a = e;
      },
    ],
    execute: function () {
      var e;
      ((o = new Map()
        .set(a.SideType.GDI, "Allied")
        .set(a.SideType.Nod, "Russian")
        .set(a.SideType.ThirdSide, "Yuri")),
        ((e = l || t("EvaPriority", (l = {})))[(e.Low = 0)] = "Low"),
        (e[(e.Normal = 1)] = "Normal"),
        (e[(e.Important = 2)] = "Important"),
        (e[(e.Critical = 3)] = "Critical"),
        t(
          "EvaSpecs",
          (i = class {
            constructor(e) {
              ((this.sideType = e), (this.specs = new Map()));
            }
            readIni(t) {
              let e = t.getSection("DialogList");
              if (!e) throw new Error("Missing eva.ini [DialogList] section");
              var i,
                r,
                s = new Set(e.entries.values()),
                n = o.get(this.sideType);
              if (!n)
                throw new Error(
                  `Unhandled side type "${a.SideType[this.sideType]}"`,
                );
              for (i of s)
                if (i) {
                  let e = t.getSection(i);
                  e
                    ? ((r = {
                        text: e.getString("Text"),
                        sound: e.getString(n),
                        priority: e.getEnum("Priority", l, l.Normal, !0),
                        queue:
                          "queue" === e.getString("Type").trim().toLowerCase(),
                      }),
                      this.specs.set(i, r))
                    : console.warn(`Missing eva section [${i}]`);
                }
              return this;
            }
            getSpec(e) {
              return this.specs.get(e);
            }
          }),
        ));
    },
  };
});
