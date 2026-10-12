# イベントメッセージング基盤の選定（Kafka / SQS・SNS / NATS JetStream / Pub/Sub / Redpanda）と、生成コードが出す Port・Outbox・配送保証（2026-10 時点）

前提（このリポジトリの現状。比較のための文脈で、外部ソースではない）: 生成コードは `application/policies.py`（イベント → Use case）を持ち、配送は `_runtime.py` の `dispatch()` によるプロセス内配送だけ。「確実な配送（Outbox 等）はアダプタの責務」としている（docs/09-implementation-decisions.md:77）。`idempotency_key` を持つ Use case は `IdempotencyStore` に成功結果を同じトランザクション・コミット前に記録し、`(use_case, key)` を一意にする（docs/05:131, docs/10:321）。イベントは `event_type: "<Context>.<Event>"` のタグと `parse_event()` を持ち、JSON にそのまま直列化できる（docs/09:191, :313）。マルチテナンシーは org_id と PostgreSQL RLS（非スーパーユーザーのロールで実行）を使う（直近のコミット）。

## 1. Transactional outbox: polling publisher と CDC（Debezium / Debezium Server / 論理レプリケーション）、テーブル設計、順序、掃除、ライブラリ、落とし穴

### Takeaway
生成コードの既定は「同じトランザクションで outbox に INSERT し、polling relay が送る」形がよい。Debezium Server に SQS sink がなく、PGlite のテストには WAL がないので、CDC（Debezium の Outbox Event Router）は Kafka / Pub/Sub / NATS 向けのオプトインのアダプタとする。テーブルは Debezium の既定スキーマ（`id, aggregatetype, aggregateid, type, payload`）と互換にしておくと、あとで CDC に移れる。

### Cited Findings
- パターンの定義: 送り手はビジネスエンティティを更新するのと同じ DB トランザクションで、送るメッセージを outbox に保存する。別のメッセージリレーがそれを読んでブローカーに送る。リレーには polling publisher（定期的に未送信を問い合わせる）と transaction log tailing（トランザクションログを読む）の2つがある。「トランザクションがコミットした場合に限り、メッセージは必ず送られる」 — [microservices.io: Transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html)
- 欠点: リレーは送信後・送信済みを記録する前にクラッシュすると同じメッセージを再送しうるので、コンシューマは冪等でなければならない（処理済みのメッセージ ID を記録するなど）。順序の要件として、同じ aggregate を複数のサービスインスタンスが更新しても、送った順にブローカーへ届く必要がある — [microservices.io](https://microservices.io/patterns/data/transactional-outbox.html)
- Debezium Outbox Event Router（Debezium 3.7 のドキュメント。サンプルは `3.7.0.Final`）が既定で期待する列: `id uuid NOT NULL`, `aggregatetype varchar(255) NOT NULL`, `aggregateid varchar(255) NOT NULL`, `type varchar(255) NOT NULL`, `payload jsonb NULL` — [Debezium: Outbox Event Router](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)
- ルーティング: トピック名は既定で `outbox.event.<aggregatetype>`。`aggregateid` は出力メッセージのキーになり、同じエンティティのイベントが Kafka の同じパーティションの中で順序を保つ。payload はそのまま渡す（既定は JSON。Avro なら `bytea` と `BinaryDataConverter`）。追加の列は `column:placement:alias` の形で `header` / `envelope` / `partition` に置ける — [Debezium: Outbox Event Router](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)
- outbox の変更はすべて INSERT であることが前提で、テーブルはキューとして扱われる。SMT は DELETE を自動で捨て、UPDATE の扱いは `table.op.invalid.behavior`（既定 `warn`）で決まる。このページは insert 直後の delete を推奨しているわけではない — [Debezium: Outbox Event Router](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)
- Debezium Server（Kafka を使わない sink への CDC）の sink 一覧: Kinesis, Google Cloud Pub/Sub, Pub/Sub Lite, HTTP Client, Pulsar, Azure Event Hubs, Redis Stream, NATS Streaming, NATS JetStream, Fluss, Kafka, Pravega, Infinispan, RocketMQ, RabbitMQ (Stream / Native Stream / `rabbitmq`), Milvus, Qdrant, InstructLab, JDBC, Iceberg, Databricks Zerobus。**Amazon SQS / SNS の sink はない**（ページ全文の両方の範囲で確認） — [Debezium Server](https://debezium.io/documentation/reference/stable/operations/debezium-server.html)
- Debezium Server の Pub/Sub sink は ordering が既定で有効（`debezium.sink.pubsub.ordering.enabled=true`）で、同じキーのメッセージは送った順に届く。キーが null になる（主キーのない）テーブルには `debezium.sink.pubsub.null.key` で代わりの値を設定する。NATS JetStream sink は `debezium.sink.nats-jetstream.url / stream-name（既定 DebeziumStream）/ create-stream / subjects` を持つ — [Debezium Server](https://debezium.io/documentation/reference/stable/operations/debezium-server.html)
- polling の順序の落とし穴（1）: シーケンスの ID は採番した時点で決まり、コミットの順序とは一致しない。ID 5 のトランザクションが ID 4 より先にコミットすると、カーソルで追う poller は 4 を飛ばし、あとから 4 がコミットされても二度と返さない — [cloudscale.ch: Generating truly sequential IDs in PostgreSQL (2025-10-09)](https://www.cloudscale.ch/en/engineering-blog/2025/10/09/generating-truly-sequential-ids-in-postgresql)
- その対策の1つ: 各行にトランザクション ID を `xid8` で記録し、`pg_snapshot_xmin(pg_current_snapshot())`（実行中のうち最も古いトランザクション）より小さい行だけを返す。こうすると、先に始まったトランザクションより後のトランザクションが先にコミットしても、その行を配ることがない — [event-driven.io (Oskar Dudycz): Ordering in Postgres outbox](https://event-driven.io/en/ordering_in_postgres_outbox/)。注: 同じ記事は XID を「gapless」と書いているが、ここでは採らない（XID は書き込むトランザクションにだけ遅延して割り当てられ、ロールバックしても消費される。この反論はソースのない私見なので、PostgreSQL のドキュメントで確かめること）
- polling の順序の落とし穴（2）: `FOR UPDATE SKIP LOCKED` だけで複数の relay を動かすと、あるインスタンスが同じキーの古い行をロックしている間に、別のインスタンスが新しい行を送ってしまう。修正は「他のインスタンスがつかんでいる、より古い未送信の行があるキーは飛ばす」こと — [GitHub PR: transactional outbox with polling relay](https://github.com/AlexGorbatov/order-payment-platform/pull/3)
- TypeScript のライブラリ: `outboxer`（Postgres、少なくとも1回、aggregate ごとの advisory lock で順序を保つ、MIT。個人のプロジェクト）— [GitHub: outboxer](https://github.com/sriharifortitude/outboxer)。`pg-transactional-outbox`（WAL の log tailing と polling の両方を持つ。polling ではエラーのとき `locked_until` が戻らないことがあり、再試行はリース切れを待つ）— [npm: pg-transactional-outbox](https://www.npmjs.com/package/pg-transactional-outbox)

### Inferences
- **生成器の既定は polling relay にする。** Debezium は Kafka Connect か Debezium Server（JVM）と論理レプリケーションのスロット（`wal_level=logical`）の運用を求める。SQS 向けの sink もない。生成器のテストは PGlite（WAL もレプリケーションスロットもない）で回している。だから「生成するのは outbox への書き込みと polling relay、CDC は Debezium Router と互換なテーブル設計で、あとから選べるようにする」のがよい。
- **outbox テーブルの案**（Debezium と互換な列に生成器の必要を足したもの）:
  `id uuid PK`（= CloudEvents の `id` = イベント ID）, `aggregatetype text`（`<Context>.<Aggregate>`）, `aggregateid text`, `type text`（`event_type` と同じ値）, `payload jsonb`, `org_id`（テナント。RLS の列と同じ型）, `occurred_at timestamptz`, `txid xid8 DEFAULT pg_current_xact_id()`, `position bigserial`（同じトランザクションの中の順序）, `published_at timestamptz NULL`, `attempts int`, `locked_until timestamptz NULL`, `last_error text NULL`。
  取り出す条件は `published_at IS NULL AND txid < pg_snapshot_xmin(pg_current_snapshot())` で、`ORDER BY txid, position` とする。
- **RLS との衝突（このプロジェクト特有）:** outbox に org_id の RLS ポリシーをかけると、全テナントを横断して読む relay は行を見られない。relay には専用のロール（`BYPASSRLS`、または outbox だけに relay 用ポリシー）が要る。書き込み側は Use case と同じテナントのセッションで INSERT するので、既存のポリシーのままでよい。
- **`txid < pg_snapshot_xmin` の落とし穴（推論。PostgreSQL のドキュメントで要確認）:** 書き込みをした長いトランザクションや idle in transaction のセッションが1つでもあると xmin が進まず、relay はそれより新しい行を見られなくなる（失うのではなく遅れる）。XID はクラスタ全体のものなので、同じクラスタの別データベースのセッションでも止まる可能性がある。`idle_in_transaction_session_timeout` の設定と、relay の遅延の監視が要る。
- **掃除:** 送信済みの行は `published_at` を付けておき、定期的に削除する（CDC を使うなら INSERT だけを前提にし、別のジョブが DELETE する。DELETE は SMT が捨てる）。どれだけ保持するかは、コンシューマ側の dedup（inbox）の保持期間と合わせて決める。
- **順序と並列:** aggregate ごとの順序を守るには、relay を1つにする（最も単純）か、`aggregateid` のハッシュでシャードするか、`pg_try_advisory_xact_lock(hashtext(aggregateid))` を使う。「SKIP LOCKED だけ」ではキーの順序が崩れる。
- Kafka を使うなら、Debezium Outbox Event Router は「`aggregateid` をキーにする」という生成器の方針とそのまま合う。

### Gaps
- PostgreSQL の `pg_logical_emit_message()` を使う outbox（テーブルを使わず WAL に直接書く方式）は調べていない。
- Python で保守されている汎用の outbox ライブラリは見つからなかった（検索1回で出てきたのは SQLAlchemy の polling relay や論理レプリケーションを使う手書きの例だけで、それらのページは取得・検証していない）。
- `pg-transactional-outbox` と `outboxer` の保守状況・利用実績は確かめていない。

## 2. 順序保証: Kafka のパーティションとキー、SQS FIFO のメッセージグループと上限、SNS FIFO のファンアウト、aggregate ごとの順序とテナント単位の分割（ホットテナント、noisy neighbor）

### Takeaway
どの基盤でも「順序はキー（Kafka のキー / SQS・SNS の MessageGroupId / Pub/Sub の ordering key / NATS の subject）の中だけ」で保証される。生成器は順序のキーを **aggregate ID** にすべきで、テナント ID にしてはいけない（ホットテナントが1本の直列の列になり、スループットの上限に当たる）。

### Cited Findings
- Debezium の Outbox Router は `aggregateid` を Kafka メッセージのキーにし、同じエンティティのイベントが1つのパーティションの中で順序を保つようにしている — [Debezium: Outbox Event Router](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)
- SQS FIFO はデータをパーティションに保存し、`MessageGroupId` を内部のハッシュ関数に通してパーティションを決める。AWS は異なる値を多く取る MessageGroupId を推奨している。パーティションの数は SQS が自動で増減する — [AWS: High throughput for FIFO queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/high-throughput-fifo.html)
- 1パーティションあたりバッチありで 3,000 msg/s、send / receive / delete それぞれ 300 msg/s — [AWS: High throughput for FIFO queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/high-throughput-fifo.html)
- 高スループットでない FIFO: API アクションごとに 300 TPS、バッチ（10件）で 3,000 msg/s。高スループット FIFO（非バッチ TPS）: us-east-1 / us-west-2 / eu-west-1 で 70,000、us-east-2 / eu-central-1 で 19,000、ap-south-1 / ap-southeast-1 / ap-southeast-2 / **ap-northeast-1（東京）** / eu-south-2 で 9,000、eu-west-2 / sa-east-1 で 4,500、その他 2,400。バッチでは10倍（東京は 90,000 msg/s）。上限は Service Quotas で引き上げを申請できる — [AWS: SQS message quotas](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html)
- 高スループット FIFO を有効にすると、Deduplication scope が **Message group**、FIFO throughput limit が **Per message group ID** になる（どちらも必須の設定。変えると通常のスループットに戻る） — [AWS: Enabling high throughput for FIFO queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/enable-high-throughput-fifo.html)
- SQS FIFO は同じグループの in-flight を制限して厳密な順序を守る。その結果、テナント（グループ）ごとのスループットが制限される — [AWS: SQS fair queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-fair-queues.html)
- SNS FIFO: 購読している SQS FIFO キューには、発行した順に一度だけ配る。SQS 標準キューを購読させると、順序が崩れ重複しうる。購読者の間の順序は決まっていない。購読先のキューに届かないと（キューポリシーの誤りなど）、DLQ を設定していなければそのメッセージは捨てられ、購読者の間でずれる。SNS は message group ごとに単調増加する128ビットのシーケンス番号を付ける（raw message delivery では付かない） — [AWS: SNS FIFO message ordering](https://docs.aws.amazon.com/sns/latest/dg/fifo-topic-message-ordering.html)
- SNS FIFO の上限: アカウントあたりの Publish（Standard と FIFO の合計）は us-east-1 で 30,000 msg/s、東京などで FIFO 3,000 msg/s。message group あたり最大 300 msg/s。`FifoThroughputScope=Topic` のときトピックあたり 3,000 msg/s か 20 MB/s。`MessageGroup` にするとアカウントの既定を超えられる。FIFO トピックはアカウントあたり 1,000、トピックあたりの購読は 100 まで。メッセージサイズは既定 256 KiB で、`MaximumMessageSize` で 1 MiB まで上げられる。FIFO トピックだけがアーカイブとリプレイを持つ — [AWS: SNS endpoints and quotas](https://docs.aws.amazon.com/general/latest/gr/sns.html)
- Pub/Sub: ordering key ごとの publish は 1 MBps まで。同じキーは同じリージョンに publish しなければならない。1つのメッセージを再配信すると、そのキーの後続（ack 済みを含む）もすべて再配信される。DLQ に送られたメッセージでは順序が保たれないことがある — [Google Cloud: Ordering messages](https://docs.cloud.google.com/pubsub/docs/ordering)
- Pub/Sub で ordering と exactly-once を組み合わせると、ack は順番に届かなければならず、スループットは「毎秒数千メッセージ程度」に下がる — [Google Cloud: Exactly-once delivery](https://docs.cloud.google.com/pubsub/docs/exactly-once-delivery)

### Inferences
- **順序のキーは `aggregateid`**（Kafka のキー、SQS / SNS FIFO の `MessageGroupId`、Pub/Sub の ordering key、CloudEvents の `partitionkey`）。ドメインの不変条件は aggregate の中にあるので、それより広い順序は要らない。テナント全体の順序が必要に見えるときは、たいていモデル（aggregate の境界）を見直すべき合図。
- SQS / SNS FIFO で `MessageGroupId = tenant_id` にすると、1テナントあたり 300 msg/s（SNS）程度の直列の列になる。ホットテナントでは詰まり、ある1件が失敗すると、テナント全体がそこで止まる。aggregate ID なら、この問題はその aggregate の中に閉じる。
- Kafka でテナント ID をキーにすると、ホットテナントが1つのパーティションに集中する（ホットパーティション）。aggregate ID をキーにすれば、パーティションに均等に散る。
- 東京リージョン（ap-northeast-1）の SNS FIFO はアカウント既定で 3,000 msg/s、SQS 高スループット FIFO は 9,000 TPS。日本の中小規模の SaaS なら、たいてい足りる量。

### Gaps
- Kafka の公式ドキュメント（パーティション数の目安、`partitioner` の既定の挙動）は今回取得していない。
- SQS / SNS の上限がいつ変わったか（たとえば SQS のメッセージサイズが 256 KiB から 1 MiB になった日付）を示す一次ソースは取得していない。現在の値だけを確認した。

## 3. 配送保証: at-least-once、重複排除（SQS FIFO の dedup ID と期間）、Kafka の冪等プロデューサ・トランザクション・EOS の限界、冪等なコンシューマ（inbox テーブル）

### Takeaway
エンドツーエンドで保証できるのは「at-least-once + 冪等なコンシューマ」だけ。ブローカーの dedup（SQS FIFO 5分、NATS 既定2分）も、Kafka の EOS（Kafka の中で閉じる）も、Outbox relay が長く止まったあとの再送や、DB への副作用を守らない。だから inbox（処理済みイベント ID の記録）は必須で、生成器の既存の `IdempotencyStore` をそのまま使える。

### Cited Findings
- SQS FIFO は 5 分の deduplication interval の中で `SendMessage` を再送しても重複を入れない。content-based deduplication は**本文**の SHA-256 で ID を作り、**属性は含めない**。あるいは dedup ID を明示する — [AWS: Exactly-once processing in Amazon SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues-exactly-once-processing.html)
- 高スループット FIFO では dedup の範囲が message group になる — [AWS: Enabling high throughput for FIFO queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/enable-high-throughput-fifo.html)
- SQS の他の上限: 保持は既定4日・最大14日、visibility timeout は既定30秒・最大12時間、遅延は最大15分、バッチは10件、メッセージ属性は10個まで、メッセージサイズは最大 1 MiB（それ以上は S3 に置く Extended Client。Java と Python だけで、同期クライアントのみ） — [AWS: SQS message quotas](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html)
- Kafka の冪等性はプロデューサの再試行による重複を防ぎ、トランザクションは Kafka の read-process-write の書き込みとオフセットのコミットをまとめる。どちらも DB への書き込みや API 呼び出しを exactly-once にはしない。プロデューサ ID は再起動で引き継がれない — [Conduktor: Kafka Exactly-Once: When It Works and When It Doesn't](https://conduktor.io/blog/exactly-once-semantics-when-it-works)、[AxonOps: Exactly-once](https://axonops.com/docs/data-platforms/kafka/concepts/delivery-semantics/exactly-once)
- Kafka 3.0 から `enable.idempotence` は既定で true（`acks=all` も既定）という記述はある。ただしブログ1件だけが出典で、kafka.apache.org のプロデューサ設定では確かめていない — [AxonOps](https://axonops.com/docs/data-platforms/kafka/concepts/delivery-semantics/exactly-once)
- Kafka 4.2 で share groups（KIP-932, Queues for Kafka）が本番利用可能になった。複数のコンシューマが同じパーティションを扱え、レコード単位の ack を持つ。KIP-1222 で ack のロック延長が加わった — [Apache Kafka 4.2.0 Release Announcement](https://kafka.apache.org/blog/2026/02/17/apache-kafka-4.2.0-release-announcement/)、[Confluent: Apache Kafka 4.2](https://www.confluent.io/blog/apache-kafka-4-2-release/)。**日付の食い違い:** kafka.apache.org の URL は 2026-01-14 / 2026-02-17、Confluent の記事は 2026-03-26 リリース（KIP 38件、貢献者155人）としている。
- Redpanda は Kafka 互換のトランザクション API を持ち、冪等プロデューサと組み合わせて EOS を提供する — [Redpanda docs: Transactions](https://docs.redpanda.com/25.3/develop/transactions)
- Pub/Sub の exactly-once は**リージョンの中**・**pull 購読だけ**（push / export は不可）。成功した ack は再配信を防ぐ。publish 側の重複（publisher の再試行）は dedup しない。レイテンシは「かなり高く」なる — [Google Cloud: Exactly-once delivery](https://docs.cloud.google.com/pubsub/docs/exactly-once-delivery)
- NATS JetStream: `Nats-Msg-Id` ヘッダを使い、stream の duplicate window（既定2分、`--dupe-window`）の中で重複を捨てる。公式ドキュメントは大きな window を勧めていない — [NATS docs: JetStream model deep dive](https://docs.nats.io/jetstream/model_deep_dive)。1件の ID は約130〜150バイトのメモリを使うという推定 — [Synadia: large deduplication window](https://www.synadia.com/insights/checks/nats-large-deduplication-window)。publish の ack が失われうるので、コネクタとしては at-least-once 扱い — [Apache SeaTunnel: NatsJetStream sink](https://seatunnel.apache.org/docs/connectors/sink/NatsJetStream)。per-subject discard policy と組み合わせると stream 全体で BYOID dedup の exactly-once publication になる — [NATS blog: per-subject discard policy](https://nats.io/blog/new-per-subject-discard-policy/)
- Outbox の relay は送信後・記録前に落ちると再送するので、コンシューマは処理済みのメッセージ ID を記録するなどして冪等にする — [microservices.io](https://microservices.io/patterns/data/transactional-outbox.html)

### Inferences
- **生成器が出すべき配送保証は「at-least-once + コンシューマの冪等性（inbox）」**、順序は「aggregate の中だけ」。exactly-once とは名乗らない。
- **注意（生成器の変更が要る）:** 現状の `idempotency_key` は「コマンドの必須入力フィールド（String / UUID / Integer / Ref）」に限られ、キーを宣言しない Use case は `IdempotencyStore` を受け取らない（docs/10:317）。したがって policy から呼ばれる Use case を inbox にするには、(a) コマンドにイベント ID のフィールドを持たせて `idempotency_key` に指定する、または (b) 生成器が policy ハンドラ側で `IdempotencyStore` を使う dedup を差し込む、のどちらかが要る。「そのまま再利用できる」わけではない。
- **inbox = 既存の `IdempotencyStore`:** policy から呼ばれる Use case の冪等キーをイベント ID（CloudEvents の `source` + `id`）にすれば、「同じキーの2回目は記録を返す」「Aggregate と同じトランザクションで記録」という既存の契約がそのまま inbox になる。新しいテーブルは要らない。生成器は「policy → Use case」の呼び出しで、`(policy 名, event id)` を冪等キーにするコードを出せばよい（1つのイベントを複数の policy が受けるので、policy 名を含める）。
- **ブローカーの dedup は最適化として使う:** SQS FIFO には `MessageDeduplicationId = event id` を明示する（content-based は本文だけをハッシュするので、本文が同じ別のイベントを誤って捨てうる）。NATS には `Nats-Msg-Id = event id`、Kafka は冪等プロデューサ。relay が5分（NATS は2分）より長く止まってから再送すると、どれも重複を防げないので、inbox は省けない。
- Kafka のトランザクション（EOS）は、DB に書く Use case には役立たない。Kafka Streams のような Kafka→Kafka の処理を生成しない限り、生成器は使わなくてよい。
- 再試行と DLQ はアダプタ（またはインフラ）の責務にする: SQS は redrive policy（maxReceiveCount）、Kafka は再試行トピックと DLT、Pub/Sub は dead-letter topic、NATS は `MaxDeliver` と BackOff。生成されるハンドラは「例外を投げれば再配信される」という契約だけを持つ。

### Gaps
- NATS JetStream のコンシューマ側の double ack（`AckSync`）と exactly-once の公式な説明は取得できなかった（取得したページはランディングページだった）。
- SQS の DLQ・redrive の詳細と、Kafka の DLT の慣習の一次ソースは取得していない。
- `enable.idempotence` の既定値は kafka.apache.org で確かめていない。
- KIP-890（トランザクションの「ゾンビ」を減らす改善）がどのバージョンで完了したかは特定していない（見つかったのは常に最新リリースを指す Confluent のまとめページ https://www.confluent.io/blog/latest-apache-kafka-release/ だけで、内容が変わりうる）。

## 4. マルチテナンシー: テナントをパーティションキーにするか、テナントごとのトピックか、メッセージ属性か。分離とクォータ

### Takeaway
既定は「全テナントで1本のトピック / キュー、テナントはエンベロープの属性（`tenantid`）、順序キーは aggregate ID」。テナントごとのトピック / キューは、隔離の要件（専用テナント、データの所在）があるときのオプションにする。SQS の fair queues（2025-07〜）は MessageGroupId をテナントにする標準キューの機能で、FIFO の「MessageGroupId = aggregate」と同じキューでは両立しない。

### Cited Findings
- SQS fair queues（2025年7月発表）: 標準キューのメッセージに `MessageGroupId`（テナント ID）を付けると自動で有効になり、コンシューマのコードは変えなくてよい。API のレイテンシにもスループットにも影響しないとされる。あるテナントの in-flight が他より不釣り合いに多いと noisy neighbor とみなし、他のテナントの配信を優先する。ただし noisy なテナントの消費を絞ることはしない（容量が余れば配る）。標準キューの MessageGroupId は FIFO の MessageGroupId と同じ振る舞いではない — [AWS: SQS fair queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-fair-queues.html)、[AWS What's New 2025-07: fair queues for multi-tenant workloads](https://aws.amazon.com/about-aws/whats-new/2025/07/amazon-sqs-introduces-fair/)
- fair queues 用に静かなグループのバックログなどの CloudWatch メトリクスが加わった。dwell time を気にしないアプリには不要としている — [AWS: SQS fair queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-fair-queues.html)
- SQS の `MessageGroupId` は最大128文字。標準キューで MessageGroupId を使うと fair queues が有効になる — [AWS: SQS message quotas](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html)
- SNS FIFO トピックはアカウントあたり 1,000 まで（標準は 100,000）。SNS のサブスクリプションフィルタポリシーはトピックあたり 200 — [AWS: SNS quotas](https://docs.aws.amazon.com/general/latest/gr/sns.html)
- SQS メッセージ属性は10個まで — [AWS: SQS message quotas](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html)
- Debezium の Outbox Router は追加の列を `header` / `envelope` / `partition` に置ける（テナント列をヘッダに出せる） — [Debezium: Outbox Event Router](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)

### Inferences
- **テナント = 属性（既定）:** すべてのイベントのエンベロープに `tenantid` を必須で入れる。コンシューマは受け取ったイベントの `tenantid` でテナントのコンテキスト（RLS の `SET LOCAL app.org_id` 等）を作ってから Use case を呼ぶ。こうすると、生成済みの RLS がそのまま下流のテナント分離にも効く。テナント ID をペイロードから取らずエンベロープから取るのは、ルーティング・フィルタ・監査がペイロードを解析しなくて済むため。
- **テナント = パーティションキー（非推奨）:** テナントの中の順序は手に入るが、ホットテナントでホットパーティション・直列化が起き、1件の失敗がテナント全体を止める。生成器のモデル（aggregate の不変条件）はテナント単位の順序を要しない。
- **テナントごとのトピック / キュー（オプション）:** 隔離（暗号鍵・保持期間・データの所在）やテナントごとのクォータには強いが、テナント数に比例してリソースが増える（SNS FIFO は 1,000 トピックまで）。プロビジョニングが要り、生成コードの範囲を超える。生成器は「トピック名を決める関数（`topic_for(event)`）」を Port の外のアダプタ設定に置き、差し替えられるようにするのがよい。
- **noisy neighbor:** SQS 標準キュー + fair queues（MessageGroupId = テナント）は「順序が要らない policy」には良い既定。順序が要るなら FIFO（MessageGroupId = aggregate）になり、fair queues とは両立しない。この二者択一を policy ごとに DSL で宣言させる（`ordered: true` なら FIFO / キー、そうでなければ標準 + fair）のは一案。
- **レート制限との整合:** 生成器は既にテナントごとのレート制限を出している。消費側のテナントごとのクォータ（Kafka の client quota 等）は運用の設定で、生成コードの責務外とするのが妥当。

### Gaps
- Kafka のクォータ（client-id / user ごとの produce・fetch の制限）と、クラスタあたりのトピック・パーティション数の実用的な上限は調べていない。
- Pub/Sub と NATS のテナント分離（NATS の accounts、Pub/Sub のトピック数の上限）は調べていない。

## 5. CloudEvents v1.0.x（必須属性、拡張、Kafka / SQS のバインディング、JSON 形式）とスキーマレジストリ（Confluent、Glue、AsyncAPI 3.0、互換モード）

### Takeaway
エンベロープは CloudEvents 1.0 の JSON 形式（structured mode）にするのがよい。`id` / `source` / `specversion` / `type` が必須で、`partitionkey`（Partitioning 拡張）に aggregate ID を入れる。テナントの拡張は仕様にないので、独自拡張 `tenantid` を定義する。CloudEvents に SQS のバインディングはないので、SQS では本文に structured JSON を入れる。

### Cited Findings
- コア仕様の最新リリースは v1.0.2（main は 1.0.3-wip）。必須属性: `id`、`source`（URI-reference）、`specversion`（`"1.0"`）、`type`（逆 DNS のプレフィックスを推奨）。任意: `datacontenttype`、`dataschema`、`subject`、`time`（RFC 3339）。「Producer は `source` + `id` が異なるイベントごとに一意であることを保証しなければならない」 — [CloudEvents spec](https://github.com/cloudevents/spec/blob/main/cloudevents/spec.md)、[cloudevents/spec リポジトリ](https://github.com/cloudevents/spec)
- 拡張属性の名前: 小文字の ASCII 英字と数字のみ、英字で始めることを推奨、1文字以上で20文字以内が望ましい、`data` は使えない — [CloudEvents spec](https://github.com/cloudevents/spec/blob/main/cloudevents/spec.md)
- 文書化された拡張は13個: Auth Context, BAM, Data Classification, Dataref (Claim Check), Deprecation, Distributed Tracing, Expiry Time, OPC UA, Partitioning, Recorded Time, Sampling, Sequence, Severity。**テナントの拡張はない** — [CloudEvents extensions README](https://github.com/cloudevents/spec/blob/main/cloudevents/extensions/README.md)
- プロトコルバインディング: AMQP, HTTP, Kafka, MQTT, NATS（いずれも v1.0.2）、WebSockets は草案。**AWS SQS のバインディングはない**。イベント形式: JSON, Avro, Protobuf（v1.0.2）。SDK: C#, Go, Java, JavaScript, Kotlin, PHP, PowerShell, Python, Ruby, Rust — [cloudevents/spec リポジトリ](https://github.com/cloudevents/spec)
- Kafka バインディング: binary mode（data を value にそのまま入れ、属性は `ce_` 接頭辞のヘッダ、`content-type` = `datacontenttype`）と structured mode（value に属性と data を入れ、`content-type: application/cloudevents+json; charset=UTF-8`）。受け手は `content-type` が `application/cloudevents` で始まるかで判別する。バッチは非対応。既定ではユーザーの指定したキーがレコードキーになり、オプトインの Key Mapper は `partitionkey` をそのままキーにコピーする（属性は残す）。binary で data がないとトゥームストーンになる — [CloudEvents Kafka protocol binding](https://github.com/cloudevents/spec/blob/main/cloudevents/bindings/kafka-protocol-binding.md)
- Confluent Schema Registry の互換モード: 既定は `BACKWARD`（直前のバージョンとだけ比べる）。BACKWARD / BACKWARD_TRANSITIVE はコンシューマを先に上げる。FORWARD / FORWARD_TRANSITIVE はプロデューサを先に上げる。FULL / FULL_TRANSITIVE は独立に上げられる。NONE は検査しない — [Confluent: Schema Evolution and Compatibility](https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html)
- AsyncAPI 3.0: operation がチャネルから分離され、`action: send | receive` でチャネルを指す。旧来の publish / subscribe は Channel Object から消えた。プロトコル固有の情報は servers / channels / operations / messages に付ける bindings に書く — [AsyncAPI 3.0.0 specification](https://www.asyncapi.com/docs/reference/specification/v3.0.0)

### Inferences
- **生成器の対応付け:** `id` = イベント ID（UUID。outbox の `id`）。`source` = `/<service>/<context>`（または URN）。`type` = 逆 DNS の接頭辞 + 既存の `event_type`（例 `com.example.billing.InvoiceIssued`。接頭辞は DSL のプロジェクト設定で与える。接頭辞なしの `"<Context>.<Event>"` も仕様上は SHOULD 違反にとどまる）。`subject` = aggregate ID。`time` = occurred_at。`datacontenttype` = `application/json`。`dataschema` = 生成した JSON Schema の URI。`partitionkey` = aggregate ID。独自拡張 `tenantid`（小文字英数字・20文字以内の規則に合う）。トレースには Distributed Tracing 拡張（`traceparent`）。
- **トランスポートごとのモード:** Kafka は binary mode（ヘッダ + JSON の value。キーは `partitionkey`）。SQS / SNS は structured mode の JSON を本文に入れる（属性は10個までなので、binary 風に属性へ展開すると拡張を足したときにあふれる。必要なら `type` と `tenantid` だけをフィルタ用の属性に複製する）。NATS はバインディングがある。
- **スキーマ:** 生成器は既にイベントの JSON Schema 相当（Pydantic / TypeScript の検証）を持つので、AsyncAPI 3.0 の文書（channels = トピック、operations = publish する側は send / policy は receive、messages = 各イベントの payload スキーマ）を生成物に加えるのは安く、レジストリ製品にも依存しない。互換性は「イベントにフィールドを足すのは任意フィールドだけ」を DSL の検証で守らせれば、BACKWARD（コンシューマ先行）と同じ規律になる。
- Confluent Schema Registry / Glue は Avro / Protobuf を使うときに効く。JSON で始めるなら、生成器が必須にするべきものではない（アダプタのオプション）。

### Gaps
- AWS Glue Schema Registry の互換モードと対応形式は調べていない。
- AsyncAPI の Kafka / SQS バインディングの具体的なフィールドと、AsyncAPI で CloudEvents を表す慣習は取得できなかった。
- Partitioning 拡張の個別ページ（`partitionkey` の正式な定義）は直接は取得していない。属性名は Kafka バインディングの記述から確認した。

## 6. Port の設計と標準的なクライアントライブラリ（Python / TypeScript、2026）

### Takeaway
生成コードが持つべきなのはトランスポートに依存しない3つの Port だけ: (1) Use case が使う **`EventPublisher`**（実装は「同じトランザクションで outbox に書く」）、(2) relay が使う **`MessageTransport.send(envelopes)`**（Kafka / SQS / SNS / NATS / Pub/Sub のアダプタ）、(3) 受信側は**エンベロープ → `parse_event` → policy → Use case（冪等キー = policy + event id）**というハンドラ関数。TS の Kafka は kafkajs（npm の最新が 2023-02 の 2.2.4）ではなく `@confluentinc/kafka-javascript`、Python の Kafka は `confluent-kafka`（asyncio の `AIOProducer` / `AIOConsumer` あり）か `aiokafka`。

### Cited Findings
- kafkajs: npm の最新は 2.2.4（公開 2023-02-27） — [npm: kafkajs](https://www.npmjs.com/package/kafkajs)。README は「少人数のボランティアが保守している」とし、廃止の告知はない — [GitHub: tulios/kafkajs](https://github.com/tulios/kafkajs)。上流で 2024 年半ばからコミットがないと書く二次情報もある（未検証） — [openapps.pro: kafkajs](https://openapps.pro/packages/kafkajs)
- `@confluentinc/kafka-javascript`: Confluent が GA と発表した librdkafka ベースの JS クライアントで、node-rdkafka と KafkaJS に似た API を持ち移行しやすい — [Confluent blog: Introducing confluent-kafka-javascript](https://www.confluent.io/blog/introducing-confluent-kafka-javascript/)。npm の最新は 1.11.0（2026-10-07） — [npm: @confluentinc/kafka-javascript](https://www.npmjs.com/package/@confluentinc/kafka-javascript)、[changelog](https://docs.confluent.io/kafka-clients/javascript/current/changelog.html)
- 純 TS の Kafka クライアントの選択肢として `@platformatic/kafka` 2.14.0（2026-10-07） — [npm: @platformatic/kafka](https://www.npmjs.com/package/@platformatic/kafka)（機能・成熟度は調べていない）
- `@aws-sdk/client-sqs` 3.1149.0（2026-10-09） — [npm: @aws-sdk/client-sqs](https://www.npmjs.com/package/@aws-sdk/client-sqs)。ポーリングのコンシューマ `sqs-consumer` 15.0.4（2026-09-25） — [npm: sqs-consumer](https://www.npmjs.com/package/sqs-consumer)
- `confluent-kafka`（Python）2.16.0（2026-10-07） — [PyPI: confluent-kafka](https://pypi.org/project/confluent-kafka/)。`confluent_kafka.aio` の `AIOProducer` / `AIOConsumer` はネイティブ asyncio 向けで、イベントループを止めず同期クライアントと同等のスループットとされる — [Confluent blog: Kafka client updates (KIP-848, OAuth)](https://www.confluent.io/blog/kafka-client-updates-kip-848-oauth/)。changelog — [Confluent Python changelog](https://docs.confluent.io/kafka-clients/python/current/changelog.html)
- `aiokafka` 0.14.0（2026-04-29） — [PyPI: aiokafka](https://pypi.org/project/aiokafka/)。`boto3` 1.43.111（2026-10-09） — [PyPI: boto3](https://pypi.org/project/boto3/)。`aioboto3` 15.5.0（2025-10-30） — [PyPI: aioboto3](https://pypi.org/project/aioboto3/)。`nats-py` 2.16.0（2026-09-16） — [PyPI: nats-py](https://pypi.org/project/nats-py/)
- SQS の大きいメッセージ用 Extended Client は Java と Python だけで、同期クライアントでしか動かない — [AWS: SQS message quotas](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html)
- CloudEvents の SDK は Python と JavaScript にもある — [cloudevents/spec リポジトリ](https://github.com/cloudevents/spec)

### Inferences
- **Port 案（生成コードに出すもの。名前は既存の `EventPublisher` / `UnitOfWork` に合わせる）:**
  - `Envelope`（不変の値）: `id, source, type, specversion="1.0", time, subject(aggregate id), partitionkey, tenantid, datacontenttype, dataschema?, traceparent?, data(JSON)`。`to_json()` / `from_json()` は CloudEvents の JSON 形式。生成器の `parse_event(envelope.data)` で型付きのイベントに戻す。
  - `EventPublisher.publish(events) -> Awaitable[None]`: 既存の Port。本番の実装は `OutboxEventPublisher`（Use case と同じトランザクション・同じ接続で outbox に INSERT する）。テストは In-memory。「コミット後に送る」（`publish_after_commit`）の意味は、outbox ならコミットと一体になる。
  - `OutboxStore`（アダプタ内部。relay 用）: `claim_batch(limit) / mark_published(ids) / mark_failed(id, error, retry_at)`。
  - `MessageTransport.send(envelopes: Sequence[Envelope]) -> Awaitable[None]`: 唯一のブローカー依存の Port。アダプタ: Kafka（key = partitionkey、binary mode のヘッダ）、SQS FIFO（MessageGroupId = partitionkey、MessageDeduplicationId = id、本文 = structured JSON）、SQS 標準 + fair（MessageGroupId = tenantid）、SNS FIFO、NATS（`Nats-Msg-Id` = id、subject = `<prefix>.<type>`）、Pub/Sub（orderingKey = partitionkey）。
  - 受信: `handle(envelope) -> Awaitable[None]`。テナントのコンテキストを作る → `parse_event` → `subscriptions()` で policy を選ぶ → Use case を `idempotency_key = f"{policy}:{envelope.id}"` で呼ぶ。例外は再配信に任せる（ack しない）。再試行の回数・バックオフ・DLQ はインフラ（SQS redrive、Kafka DLT、Pub/Sub dead-letter、NATS MaxDeliver / BackOff）に置き、生成コードはループを持たない（既存の「`retry: true` は宣言で、ループは生成しない」という方針と同じ）。
  - 既存の in-process の `dispatch()` は `MessageTransport` の In-memory 実装として残せる（テストと単一プロセス構成のため）。
- **ライブラリの既定（アダプタの雛形に使う場合）:** TS + Kafka は `@confluentinc/kafka-javascript`（kafkajs は npm の更新が 2023-02 で止まっている）。TS + SQS は `@aws-sdk/client-sqs`（v3）。Python + Kafka は `confluent-kafka`（asyncio は `confluent_kafka.aio`）。純 Python がよければ `aiokafka`。Python + SQS は `boto3`（同期）か `aioboto3`（非同期）。ただし生成コードの中核（domain / application）はどれにも依存させず、アダプタの雛形は生成しても例として扱うのが、既存の「アダプタの責務」方針に沿う。
- Bun を使う方針（メモリの指示）との関係: `@confluentinc/kafka-javascript` は librdkafka のネイティブアドオンなので、Bun での動作は確かめる必要がある（未確認）。

### Gaps
- `@confluentinc/kafka-javascript` が Bun（ネイティブアドオン / N-API）で動くかは調べていない。
- `AIOConsumer` が入った正確なバージョンは確認できなかった（2.14〜2.15 という二次情報のみ）。
- `@platformatic/kafka` の成熟度・採用状況は調べていない。

## 7. 運用コストと複雑さの比較、どれを既定にすべきか

### Takeaway
生成器の既定は「ブローカーを選ばない Port + Postgres の outbox + polling relay + inbox（`IdempotencyStore`）」で、最初のアダプタは **AWS なら SQS（標準 + fair queues、順序が要るものだけ FIFO）/ ファンアウトが要るなら SNS（FIFO）+ SQS**。イベントの再生・長期保持・多数のコンシューマ・ストリーム処理が要るときに Kafka（Redpanda / MSK / Confluent Cloud）。この結論は下の一次ソースの性質から導いた推論で、コストの数値は集めていない。

### Cited Findings
- SQS 標準キューは API 呼び出しの数がほぼ無制限で、自動でスケールする — [AWS: SQS message quotas](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html)
- SQS の保持は最大14日。リプレイの仕組みはない（受け取って削除するモデル）。SNS で再生（アーカイブとリプレイ）を持つのは FIFO トピックだけ — [AWS: SQS message quotas](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html)、[AWS: SNS quotas](https://docs.aws.amazon.com/general/latest/gr/sns.html)
- AWS 自身が、厳密な順序が要らず量が少ないなら高スループット FIFO は不要で、標準キューのほうがコスト効率がよく管理しやすいと書いている — [AWS: High throughput for FIFO queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/high-throughput-fifo.html)
- Kafka 4.2 の share groups でキューとしての使い方（レコード単位の ack、パーティション数を超える並列）ができるようになった — [Apache Kafka 4.2.0 Release Announcement](https://kafka.apache.org/blog/2026/02/17/apache-kafka-4.2.0-release-announcement/)
- Debezium（CDC）は Kafka Connect か Debezium Server を動かす必要があり、Debezium Server には SQS の sink がない — [Debezium Server](https://debezium.io/documentation/reference/stable/operations/debezium-server.html)
- Pub/Sub の exactly-once はレイテンシが高く、ordering と組み合わせるとスループットが毎秒数千程度に下がる — [Google Cloud: Exactly-once delivery](https://docs.cloud.google.com/pubsub/docs/exactly-once-delivery)
- Redpanda は Kafka API 互換で、トランザクションと冪等プロデューサを持つ（ベンダーは Kafka より高スループットと主張） — [Redpanda docs: Transactions](https://docs.redpanda.com/25.3/develop/transactions)、[Redpanda blog: 22.3](https://www.redpanda.com/blog/fast-transactions)

### Inferences
- **SQS / SNS（AWS 前提のとき既定）:** サーバーレスで運用するものがほぼない。fair queues で noisy neighbor に標準で対処できる。FIFO で aggregate ごとの順序と5分の dedup が得られる。弱み: リプレイがない（SNS FIFO のアーカイブを除く）、14日で消える、CloudEvents のバインディングがない、属性は10個、AWS に縛られる、SNS FIFO の購読はトピックあたり100。
- **Kafka（MSK / Confluent Cloud / 自前）:** ログとして保持・再生でき、コンシューマを後から足せる。Debezium の Outbox Router が素直に使え、CloudEvents のバインディングもある。弱み: クラスタ（またはマネージドの最低料金）、パーティション設計、コンシューマグループ、スキーマレジストリの運用。小さなチームには重い。
- **Redpanda:** Kafka API 互換で単一バイナリ（JVM / ZooKeeper なし）なので、ローカル開発や CI の Kafka 代わりとして生成器のテスト環境に向く。ライセンスは要確認。
- **NATS JetStream:** 軽量で、自前でホストしやすく、CloudEvents のバインディングもある。dedup の window は短い（既定2分）。セルフホストや非 AWS 環境の既定候補。
- **Google Pub/Sub:** GCP 前提なら SQS + SNS と同じ位置づけ（ordering key と dead-letter topic、Debezium Server の sink あり）。exactly-once は pull・同一リージョン限定で、publish 側の重複は防がないので、inbox はやはり必要。
- **生成器への推奨のまとめ:**
  1. 生成するもの: `Envelope`（CloudEvents 1.0 JSON + `partitionkey` + `tenantid`）、`OutboxEventPublisher`（同じトランザクションで INSERT）、outbox のマイグレーション（Debezium と互換な列 + `org_id` + `txid xid8`）、polling relay（`txid < pg_snapshot_xmin` と aggregate ごとの順序）、受信ハンドラ（policy + event id を冪等キーにして既存の `IdempotencyStore` で inbox にする）、AsyncAPI 3.0 の文書。
  2. 配送保証の宣言: at-least-once、aggregate の中だけの順序、コンシューマは冪等、exactly-once とは言わない。
  3. アダプタ（オプション / 例）: SQS（標準 + fair / FIFO）、SNS FIFO、Kafka（`@confluentinc/kafka-javascript` / `confluent-kafka`）、NATS、Pub/Sub、Debezium の設定例（Kafka / Pub/Sub / NATS 向けの CDC）。
  4. テストは In-memory の transport と PGlite の outbox で回す（WAL に依存しない polling だから可能）。

### Gaps
- 各サービスの料金（SQS / SNS のリクエスト単価、MSK / Confluent Cloud / Redpanda Cloud / Synadia Cloud の最低料金）の一次ソースは集めていない。コストの比較は定性的な推論だけ。
- Redpanda（本体と Redpanda Connect）の 2026 年のライセンスは確認できなかった。
- 実運用の体験談（エンジニアリングブログ）で SQS と Kafka を比べたものは今回集めていない。
