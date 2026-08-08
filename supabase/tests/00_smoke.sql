begin;
select plan(1);

-- pgTAP이 로드되고 테스트 러너가 동작하는지 확인하는 스모크 테스트
select ok( true, 'pgTAP smoke test runs' );

select * from finish();
rollback;
